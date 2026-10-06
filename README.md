# CrowdCAD TAK bridge

**In development. Not ready for use.** This build loads and checks its configuration but does not connect to TAK yet.

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
   4. Also get the TAK Server CA certificate, either as a PEM file or as the truststore `.p12` from a data package.
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
   # copy the bridge's .p12 to certs/client.p12, and the CA to certs/ca.pem (or certs/ca.p12)
   ```
   Fill in `.env`: the TAK section yourself, and the CrowdCAD and bridge sections from step 2.
5. **Start it:**
   ```bash
   docker compose up -d
   docker compose logs -f
   ```
6. **Check the status.** CrowdCAD shows the bridge's status in the event's TAK panel.

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

Work happens on topic branches off `integration/tak`. Every commit must be signed off (`git commit -s`) under the [Developer Certificate of Origin](https://developercertificate.org/).

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
