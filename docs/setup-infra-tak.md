# Setting up the CrowdCAD TAK bridge on an infra-TAK host

**TAK support is in development.** This guide describes the intended setup. Expect changes before a stable release.

The bridge runs as a Docker container next to your TAK Server. It receives position reports from TAK devices (ATAK, iTAK, WinTAK) over TLS CoT streaming, and puts them on the CrowdCAD dispatch map.

**What the bridge can see and write:**
- It writes only to the events whose owner linked it.
- It never reads CrowdCAD event data, calls or patient information.

## Before you start

You need:
- **The TAK host.** A TAK Server host set up with infra-TAK, with Docker and Docker Compose, and outbound HTTPS to your CrowdCAD backend.
- **Admin access to TAK Portal,** to create the bridge's TAK user.
- **A CrowdCAD admin account** (Profile shows an **Admin** area).
- **A CrowdCAD build with TAK enabled** (`NEXT_PUBLIC_TAK=on`). Without it, CrowdCAD shows no TAK options.
- **Firebase deployments only:** email/password sign-up must be enabled in Firebase Authentication, because CrowdCAD creates the bridge's account from the browser.

## 1. Create the bridge's TAK user

In TAK Portal:
1. **Create the user.** Name it something like `crowdcad-bridge`.
2. **Add it to the groups your responders use.** The bridge only receives positions from groups it belongs to.
3. **Download its certificate bundle** (`.p12`) and note the password.

The `.p12` normally includes your TAK Server's CA certificate. If yours doesn't, also export the CA as a PEM file, for example:

```bash
openssl pkcs12 -in truststore.p12 -nokeys -out ca.pem
```

## 2. Add the TAK server in CrowdCAD

1. **Start the wizard.** Go to **Profile > Admin > TAK > Add TAK server**.
2. **Name the server.** For example, "Main TAK server".
3. **Create the bridge account.** Choose **Create bridge account**. CrowdCAD creates a dedicated account for the bridge and shows a block of settings once.
4. **Copy the block now.** It contains the bridge's password, which CrowdCAD does not keep.
5. **Leave the wizard open** on "Waiting for the bridge to report in" while you do step 3.

## 3. Install the bridge on the TAK host

```bash
git clone https://github.com/crowdcad/tak-bridge.git
cd tak-bridge
mkdir certs
cp /path/to/crowdcad-bridge.p12 certs/client.p12
chmod 644 certs/*          # the container runs as an unprivileged user
cp .env.example .env
```

Edit `.env`:
- **CrowdCAD section:** paste the block from step 2 over it. It sets `CROWDCAD_BACKEND`, the backend settings, and `BRIDGE_EMAIL` and `BRIDGE_PASSWORD`.
- **TAK section:**
  - `TAK_HOST`: your TAK Server's hostname, as it appears in its certificate.
  - `TAK_CLIENT_P12_PASSWORD`: the `.p12` password.
  - `TAK_CA=/certs/ca.pem`: only if you exported the CA separately.
- **Version:** to pin a release, set `TAK_BRIDGE_VERSION=<version>` in your shell or in a `.env` line read by Compose.

Start it and follow the logs:

```bash
docker compose up -d
docker compose logs -f
```

You should see `signed in as bridge account`, then `connected to TAK Server`. The CrowdCAD wizard should switch to **Connected**.

### Optional: check the TAK side first

Set `CROWDCAD_BACKEND=none` and restart. The bridge then connects to TAK and logs every position it receives (`"msg":"position"`), but writes nothing to CrowdCAD. Use this to confirm certificates and groups before connecting CrowdCAD. Set `CROWDCAD_BACKEND` back afterwards.

## 4. Choose who can use the TAK server

In **Profile > Admin > TAK**, add the people who may use the server to **Who can use this TAK server**, by the email they sign in to CrowdCAD with. Only these users can link it to their events.

## 5. Use TAK on an event

1. **Choose TAK for the event.** In the event builder, under **Map**, choose **TAK live tracking**, pick the TAK server, and pick the location history setting:
   - **Off:** live positions only. Nothing is kept after the event.
   - **Summary (default):** 5-minute summaries and a heat map.
   - **Detailed:** Summary, plus positions every 15 seconds while a team is on a call.
2. **Align each map.** Use **Align map now** (or later, from the TAK panel on the dispatch map). Place at least 3 points you can identify on the ground, spread across the map, and enter their coordinates. Four or more points give an accuracy estimate.
3. **Link devices to teams.**
   - **Automatic:** devices link to a team when their callsign matches the team name, ignoring case and spaces.
   - **Manual:** anything else appears under **Unassigned TAK devices** in the TAK panel. Pick a team there, and CrowdCAD remembers the device for later events.
4. **End the event.** Ending the event stops live tracking. The bridge removes live positions and finishes the event's history.

## Operations

- **Upgrade.** Set `TAK_BRIDGE_VERSION` to the new release, then run `docker compose pull && docker compose up -d`.
- **Rotate the bridge account.** In **Admin > TAK**, choose **Rotate** on the server. That creates a new bridge account and settings block. Then:
  1. Install the new block on the host.
  2. Link events to the new server.
  3. **Revoke** the old one.
- **Revoke.** **Revoke** removes the bridge's access immediately. The container keeps running but can no longer write.
- **Logs.** `docker compose logs -f`. Set `LOG_LEVEL=debug` for more detail.

### Troubleshooting

| Message or symptom | Likely cause and fix |
|---|---|
| `password (TAK_CLIENT_P12_PASSWORD) is wrong` | Check the `.p12` password. |
| `uses legacy encryption` | Re-export the `.p12` with the command in the message, or add `NODE_OPTIONS=--openssl-legacy-provider` to `.env`. |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN` | The bridge doesn't trust the server's certificate. Export the CA as PEM and set `TAK_CA`. |
| `ERR_TLS_CERT_ALTNAME_INVALID` | Set `TAK_SERVER_NAME` to the name in the server certificate. |
| Connected, but no positions | The bridge user isn't in the devices' TAK groups. |
| `could not sign in to CrowdCAD as the bridge account` | Re-check `BRIDGE_EMAIL` and `BRIDGE_PASSWORD`, or rotate the bridge account. |
| `live write failed ... permission` | The event isn't linked to this bridge, is paused, or has ended. Or the bridge was revoked. |
| PocketBase: cannot reach `POCKETBASE_URL` | Use an address the TAK host can reach. That's often a LAN address, not the one in your browser. |

### Optional: Firestore TTL backstop

The bridge deletes live positions itself when an event ends, and on startup. As an extra safeguard on Firebase, an operator can add a TTL policy on the `takLive` collection group's `receivedAt` field:

```bash
gcloud firestore fields ttls update receivedAt --collection-group=takLive --enable-ttl
```

TTL deletes run on Firestore's own schedule, typically within a day. Correctness never depends on them.

## What is stored

- **Live positions.** One record per device per event, overwritten as the device reports, and removed when the event ends.
- **Location history** (Summary or Detailed only). Per device and team: 5-minute summaries and a heat-map grid. Detailed adds points while the team is on a call. Only the event's owner can view history.
- **Status.** The bridge's heartbeat (last seen, connected), shown to admins and allowed users.

The bridge's certificate files and `.env` stay on your TAK host. Keep them readable only by the account that runs Docker.
