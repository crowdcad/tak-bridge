# Setting up the CrowdCAD TAK bridge

**TAK support is in development.** This guide describes the intended setup. Expect changes before a stable release.

The bridge is a small program that signs in to your TAK Server like a phone does, receives position reports from TAK devices (ATAK, iTAK, WinTAK), and puts them on the CrowdCAD dispatch map. For real use it runs as a Docker container on the TAK Server machine. For a test it can run on your own computer.

**What the bridge can see and write:**
- It writes only to the events whose owner linked it.
- It never reads CrowdCAD event data, calls or patient information.
- It only receives positions from the TAK groups its TAK user belongs to.

Most of the setup happens in CrowdCAD's **Add TAK server** screen, which builds the bridge's settings and the exact commands to run. This guide explains each step and what to do when something goes wrong.

## Three names you will see

TAK setups often involve three different names. They are easy to mix up:

| Name | Example | What it is | Used for |
|---|---|---|---|
| **TAK Portal address** | `takportal.example.org` | The web page where you manage TAK users. | Creating the bridge's TAK user. The bridge never connects to it. |
| **TAK Server address** | `takserver.example.org` | The server phones connect to: port 8089 for positions, port 8446 for certificate enrollment. | `TAK_HOST`. This is what goes in the wizard. |
| **Name in the server certificate** | `takserver` | The name TAK Server's own certificate was issued to. Often an internal name, not a real address. | Nothing, normally. The bridge trusts the TAK Server's CA without checking this name, unless you set `TAK_SERVER_NAME`. |

If you are not sure of the TAK Server address, look at the **Enroll QR** link in TAK Portal (step 1): its `host=` part is the TAK Server address.

## Before you start

You need:
- **Admin access to TAK Portal,** to create the bridge's TAK user.
- **A CrowdCAD admin account** (Profile shows an **Admin** area).
- **A CrowdCAD build with TAK enabled** (`NEXT_PUBLIC_TAK=on`). Without it, CrowdCAD shows no TAK options.
- **Firebase deployments only:** email/password sign-up must be enabled in Firebase Authentication, because CrowdCAD creates the bridge's account from the browser.
- **Firebase deployments only:** the `takConfig` index, created once per Firebase project. See [Firebase: create the index](#firebase-create-the-index-once-per-project) below.
- **Where the bridge will run:**
  - **On the TAK Server machine (real use):** Docker with Docker Compose, git, and outbound HTTPS to your CrowdCAD backend.
  - **On your computer (test):** Node.js 22 or newer and git. Your computer must be able to reach the TAK Server on ports 8446 and 8089.

### Firebase: create the index (once per project)

The bridge finds the events linked to it with one Firestore query across every event's `takConfig`. Real Firestore needs an index for that query (the emulators don't). Without it the bridge connects to TAK and CrowdCAD but never sees an event. Its log shows:

```
"msg":"watching linked events failed","message":"The query requires a COLLECTION_GROUP_ASC index for collection takConfig and field bridgeUid. ..."
```

Create it once per Firebase project, before or after starting the bridge, in either of these ways:

- **From a CrowdCAD checkout** (its `firestore.indexes.json` defines it):

  ```bash
  firebase deploy --only firestore:indexes --project YOUR_PROJECT_ID
  ```

- **In the Firebase console:** open the link in the bridge's log message, or go to **Firestore Database > Indexes > Single field > Add exemption** and enter collection ID `takConfig`, field path `bridgeUid`, with **Collection group** scope **Ascending** enabled. Keep the collection-scope indexes as they are.

The index takes a few minutes to build; the console shows its status. Then restart the bridge (`docker compose restart`, or stop and start it with Node). The log should show `linked events` with no error before it.

## 1. Create the bridge's TAK user

In TAK Portal:
1. **Create a user** for the bridge, for example `crowdcad-bridge`, and give it a password. Keep the password for step 2.
2. **Add it to the groups your responders' phones use.** The bridge only receives positions from groups it belongs to. If it's in none of the right groups, it connects fine but sees nobody.
3. **Open the user's Enroll QR.** This is what a phone would scan to get a certificate. The bridge uses the same process:
   - if TAK Portal shows the link next to the code, copy it;
   - otherwise scan the code with a phone camera and copy the text it shows. It looks like `tak://com.atakmap.app/enroll?host=…&username=…&token=…`.

   The link is optional. In CrowdCAD it fills in only the TAK Server address and username; you always type the password.

You do not need to download a certificate (`.p12`). The bridge creates its own private key, which never leaves the machine it runs on, and asks TAK Server to sign it (enrollment, port 8446). It saves the certificate and renews it before it expires.

**Password, not token.** Use the user's real password. A token from the Enroll QR may work only once, and the bridge signs in again each time it renews its certificate. That's why CrowdCAD doesn't take the password from the link. If you do put a token in `TAK_PASSWORD` by hand, the first start works, but you'll need to update it before the certificate expires (the bridge logs a warning when renewal fails).

## 2. Add the TAK server in CrowdCAD

Go to **Profile > Admin > TAK > Add TAK server**.

1. **Name and placement.** Name the server (for example "Main TAK server") and choose where the bridge will run:
   - **On the TAK Server machine (Docker)** for real use;
   - **On this computer (test)** to try it out. CrowdCAD picks this automatically when it's running locally or on the Firebase emulators, since a bridge elsewhere couldn't reach those.
2. **TAK sign-in.** Paste the Enroll QR link to fill in the **TAK Server address** and **username**, or type them (the TAK Server address, not the TAK Portal address). Then type the TAK user's **password**; use the eye button to check it, since a browser can autofill a saved password into that field. CrowdCAD doesn't save these; they only go into the bridge's settings. Passwords with characters such as `$` or `#` are quoted in `.env` automatically.
3. **Create bridge settings.** CrowdCAD creates a dedicated CrowdCAD account for the bridge and shows:
   - the commands to paste, which download the bridge, write its complete `.env`, and start it;
   - the `.env` on its own, under **Just the .env contents**.

   **Copy it now.** It contains the bridge's CrowdCAD password and the TAK password, and is shown only once. If you lose it, use **Rotate**.
4. **Run the commands** (step 3 of this guide), then choose **I've copied it and started the bridge**.
5. **Watch the checklist.** CrowdCAD shows three checks, updated as the bridge reports in (about once a minute):
   - **Bridge signed in to CrowdCAD**
   - **Connected to the TAK Server**
   - **Receiving positions** (with the number of devices seen)

   When something is wrong, the checklist says what, in plain words. See [Troubleshooting](#troubleshooting).

## 3. Run the bridge

### On the TAK Server machine (Docker)

Sign in to the machine (for example with `ssh`), go to the folder where the bridge should live, and paste the commands from CrowdCAD. They look like this, with your settings filled in:

```bash
git clone https://github.com/crowdcad/tak-bridge.git
cd tak-bridge
cat > .env <<'EOF'
TAK_HOST=takserver.example.org
TAK_USERNAME=crowdcad-bridge
TAK_PASSWORD=…
CROWDCAD_BACKEND=firebase
…
BRIDGE_EMAIL=…
BRIDGE_PASSWORD=…
EOF
chmod 600 .env
docker compose up -d --build
docker compose logs -f
```

In the log, look for `enrolled with TAK Server`, `linked events` and `connected to TAK Server`. On Firebase, a `watching linked events failed` error just before `linked events` means the [index](#firebase-create-the-index-once-per-project) is missing. Press Ctrl+C to stop watching the log; the bridge keeps running and starts again after a reboot.

The enrolled certificate is kept in a Docker volume (`tak-bridge-data`), so it survives restarts and upgrades. To force a new certificate, run `docker compose down -v` (this deletes the volume) and start again.

If TAK Server runs in Docker on the same machine and `TAK_HOST` should point at the machine itself, uncomment the `extra_hosts` lines in `docker-compose.yml` and set `TAK_HOST=host.docker.internal`.

### On your computer (test)

Open PowerShell (Windows) or Terminal (macOS, Linux), go to a folder for the bridge (for example `cd $HOME` or `cd ~`), and paste the commands from CrowdCAD. They download the bridge, write `.env`, build it, and run it:

```bash
git clone https://github.com/crowdcad/tak-bridge.git
cd tak-bridge
# (writes .env)
npm ci
npm run build
node --env-file=.env dist/index.js
```

Keep the window open while testing; Ctrl+C stops the bridge. To start it again later, run `node --env-file=.env dist/index.js` in the `tak-bridge` folder. The enrolled certificate is saved in `tak-bridge/data/`.

**Local CrowdCAD with the Firebase emulators:** the settings CrowdCAD generates include `FIREBASE_AUTH_EMULATOR_HOST` and `FIRESTORE_EMULATOR_HOST`, so the bridge talks to the same emulators as your browser. The emulators must be running before you start the bridge.

### Optional: check the TAK side on its own

Set `CROWDCAD_BACKEND=none` in `.env` and restart the bridge. It then enrolls, connects to TAK and logs every position it receives (`"msg":"position"`), but writes nothing to CrowdCAD. Use this to confirm the TAK user and its groups before involving CrowdCAD. Set `CROWDCAD_BACKEND` back afterwards.

## 4. Choose who can use the TAK server

In **Profile > Admin > TAK**, add the people who may use the server to **Who can use this TAK server**, by the email they sign in to CrowdCAD with. Only these users can link it to their events. The admin who added the server is included automatically.

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

- **Upgrade (Docker).** In the `tak-bridge` folder: `git pull && docker compose up -d --build`. Once releases are published you can instead set `TAK_BRIDGE_VERSION` to a release and run `docker compose pull && docker compose up -d`.
- **Certificate renewal.** Automatic: the bridge checks twice a day and enrolls again when fewer than 30 days remain. It needs `TAK_PASSWORD` to still be valid.
- **Rotate the bridge account.** In **Admin > TAK**, choose **Rotate** on the server. The wizard creates a new bridge account and settings. Then:
  1. Replace `.env` on the bridge machine with the new one and restart (`docker compose up -d`).
  2. Link events to the new server.
  3. **Revoke** the old one.
- **Revoke.** **Revoke** removes the bridge's CrowdCAD access immediately. The container keeps running but can no longer write. To also cut its TAK access, disable the TAK user in TAK Portal.
- **Logs.** `docker compose logs -f`. Set `LOG_LEVEL=debug` for more detail.

### Troubleshooting

The checklist in CrowdCAD and the server's row in **Admin > TAK** show the bridge's latest TAK problem in plain words. The same text appears in the bridge's log as `hint`.

| Message or symptom | Likely cause and fix |
|---|---|
| Checklist stuck on **Bridge signed in to CrowdCAD** | The bridge isn't running, or can't sign in. Check its log for `could not sign in to CrowdCAD`: re-check `BRIDGE_EMAIL`, `BRIDGE_PASSWORD` and the backend settings, or Rotate. On a local test with emulators, make sure they are running. |
| `TAK Server refused the username or password` | Wrong `TAK_USERNAME` or `TAK_PASSWORD`, or a one-time Enroll QR token that was already used. Check the password with `curl -s -o /dev/null -w '%{http_code}
' -u 'USER:PASSWORD' https://TAK_HOST:8446/Marti/api/tls/config` (200 means it's right; then check `.env`, for example with `docker compose config`). Older CrowdCAD versions could put an Enroll QR token or a browser-autofilled password in `TAK_PASSWORD`; set the user's real password by hand. |
| `watching linked events failed ... requires a COLLECTION_GROUP_ASC index` (Firebase) | The `takConfig` index is missing. [Create it](#firebase-create-the-index-once-per-project), wait for it to build, and restart the bridge. Until then the bridge sees no events. |
| `Cannot reach TAK Server enrollment at …:8446` | `TAK_HOST` is the TAK Portal address instead of the TAK Server address, or port 8446 is blocked from where the bridge runs. |
| `…set TAK_CA to the TAK Server CA` (enrollment) | Port 8446 uses TAK Server's own CA rather than a public certificate. Export the CA as PEM (for example `openssl pkcs12 -in truststore.p12 -nokeys -out ca.pem`), put it next to `.env`, and set `TAK_CA`. In Docker, mount it into the container (for example in `certs/`, as `/certs/ca.pem`). |
| `Connection refused: check TAK_HOST and TAK_STREAM_PORT` | Nothing listening on 8089 at that address, or a firewall. |
| `The TAK Server rejected the bridge certificate` | The TAK user was disabled or deleted, or its certificate was revoked. Check the user in TAK Portal, then force a new certificate (delete the data volume or `data/` folder) and restart. |
| `The server certificate's name doesn't match` | `TAK_SERVER_NAME` is set to the wrong name. Unset it, or set it to the name in the server certificate. |
| Connected, but **Receiving positions** stays at 0 devices | The bridge user isn't in the devices' TAK groups, or no phone is connected right now. |
| `live write failed ... permission` | The event isn't linked to this bridge, is paused, or has ended. Or the bridge was revoked. |
| PocketBase: cannot reach `POCKETBASE_URL` | Use an address the bridge machine can reach. That's often a LAN address, not the one in your browser. |

**Using a `.p12` instead.** If you already have a client certificate bundle for the bridge user, set `TAK_CLIENT_P12` and `TAK_CLIENT_P12_PASSWORD` instead of `TAK_USERNAME`/`TAK_PASSWORD`, and put the file in `certs/` (readable by the container: `chmod 644 certs/*`). If both are set, the bridge enrolls and only uses the `.p12` when enrollment fails. Errors you may see with a `.p12`:
- `password (TAK_CLIENT_P12_PASSWORD) is wrong`;
- `uses legacy encryption`: re-export it with the command in the message, or add `NODE_OPTIONS=--openssl-legacy-provider` to `.env`.

### Optional: Firestore TTL backstop

The bridge deletes live positions itself when an event ends, and on startup. As an extra safeguard on Firebase, an operator can add a TTL policy on the `takLive` collection group's `receivedAt` field:

```bash
gcloud firestore fields ttls update receivedAt --collection-group=takLive --enable-ttl
```

TTL deletes run on Firestore's own schedule, typically within a day. Correctness never depends on them.

## What is stored

- **Live positions.** One record per device per event, overwritten as the device reports, and removed when the event ends.
- **Location history** (Summary or Detailed only). Per device and team: 5-minute summaries and a heat-map grid. Detailed adds points while the team is on a call. Only the event's owner can view history, on the event summary page after the event ends.
- **Status.** The bridge's heartbeat (last seen, connected to TAK, devices seen, last position time, last TAK problem), shown to admins and allowed users.

The bridge's `.env`, its private key and certificate (in the `tak-bridge-data` volume or `data/` folder) stay on the machine it runs on. Keep them readable only by the account that runs the bridge.
