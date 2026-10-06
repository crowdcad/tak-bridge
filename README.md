# CrowdCAD TAK bridge

**In development. Not ready for use.** This build connects to a TAK Server and logs device positions. It does not write to CrowdCAD yet.

The bridge runs next to a TAK Server and puts the positions of TAK devices (ATAK, iTAK, WinTAK) on the [CrowdCAD](https://github.com/crowdcad/crowdcad) dispatch map.

- **Connections.** It connects to the TAK Server over TLS CoT streaming (port 8089) with its own client certificate. It writes to CrowdCAD (Firebase or PocketBase) as a dedicated bridge account, so CrowdCAD's security rules apply to it.
- **What it reads.** Positions only. The bridge never reads CrowdCAD event data, calls or patient information.
- **Where it writes.** Only to events whose owner linked this bridge.

Design and data model, in the CrowdCAD repository:
- [Plan](https://github.com/crowdcad/crowdcad/blob/integration/tak/docs/tak-integration/plan.md)
- [Data contract](https://github.com/crowdcad/crowdcad/blob/integration/tak/docs/tak-integration/data-contract.md)
- [Decision log](https://github.com/crowdcad/crowdcad/blob/integration/tak/docs/tak-integration/decisions.md)

## Setup on an infra-TAK host

This is the target setup. Steps 2 and 4 depend on CrowdCAD features that are still being built.

1. **Create a TAK user for the bridge.** In TAK Portal:
   1. Create a user named `crowdcad-bridge`.
   2. Add it to the TAK groups your responders use. The bridge only receives positions from groups it belongs to.
   3. Download its certificate bundle (`.p12`) and note its password.
   4. The `.p12` normally includes the TAK Server CA. If it does not, also get the CA as a PEM file (convert a truststore `.p12` with `openssl pkcs12 -in truststore.p12 -nokeys -out ca.pem`).
2. **Create a bridge connection in CrowdCAD.** It shows a one-time block of settings (backend and bridge account). Copy it now; the password is not shown again.
3. **On the TAK host,** clone this repository:
   ```bash
   git clone https://github.com/crowdcad/tak-bridge.git
   cd tak-bridge
   ```
4. **Configure it:**
   ```bash
   cp .env.example .env
   mkdir certs
   # copy the bridge's .p12 to certs/client.p12; if the .p12 lacks the CA, also add certs/ca.pem and set TAK_CA=/certs/ca.pem
   ```
   Fill in `.env`: the TAK section yourself, and the CrowdCAD and bridge sections from step 2.
   The container runs as an unprivileged user, so make the certificate files readable: `chmod 644 certs/*`.
5. **Optional: check the TAK side first.** Set `CROWDCAD_BACKEND=none`. The bridge then connects to TAK and logs each position it receives (`"msg":"position"`), but writes nothing. Switch it back once positions appear.
6. **Start it:**
   ```bash
   docker compose up -d
   docker compose logs -f
   ```
7. **Check the status.** CrowdCAD shows the bridge's status in the event's TAK panel.

`.env` and `certs/` contain secrets. Both are excluded from git and from the Docker build context. Keep them readable only by the user that runs Docker.

## Development

Requires Node 20.19 or newer. CI runs Node 22 and 24, and the image uses Node 24.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

### Simulator

A CoT simulator stands in for a TAK Server, so the bridge can be run and tested without TAK hardware. It runs synthetic devices that dwell at posts and walk between them.

```bash
npm run build
npm run dev-certs                                   # throwaway certs in ./certs/dev (gitignored)
npm run sim -- --devices 20 --hours 8 --speed 60    # 8 hours in 8 minutes; add --noise for non-position traffic

# in another terminal
TAK_HOST=localhost TAK_CLIENT_P12=certs/dev/client.p12 TAK_CLIENT_P12_PASSWORD=atakatak   CROWDCAD_BACKEND=none npm start
```

Tests use the same simulator over TLS, with certificates generated in a temporary directory (they need the `openssl` CLI).

Work lands on `integration/tak`. Every commit must be signed off (`git commit -s`) under the [Developer Certificate of Origin](https://developercertificate.org/).

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
