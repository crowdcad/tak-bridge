# CrowdCAD TAK bridge

**In development. Not ready for production use.** Full setup guide: [docs/setup-infra-tak.md](docs/setup-infra-tak.md).

The bridge runs next to a TAK Server and puts the positions of TAK devices (ATAK, iTAK, WinTAK) on the [CrowdCAD](https://github.com/crowdcad/crowdcad) dispatch map.

- **Connections.** It enrolls with the TAK Server for its own client certificate (port 8446, like a phone scanning an Enroll QR) and receives positions over TLS CoT streaming (port 8089). It writes to CrowdCAD (Firebase or PocketBase) as a dedicated bridge account, so CrowdCAD's security rules apply to it.
- **What it reads.** Positions only. The bridge never reads CrowdCAD event data, calls or patient information.
- **Where it writes.** Only to events whose owner linked this bridge.

Design and data model, in the CrowdCAD repository:
- [Plan](https://github.com/crowdcad/crowdcad/blob/integration/tak/docs/tak-integration/plan.md)
- [Data contract](https://github.com/crowdcad/crowdcad/blob/integration/tak/docs/tak-integration/data-contract.md)
- [Decision log](https://github.com/crowdcad/crowdcad/blob/integration/tak/docs/tak-integration/decisions.md)

## Setup

The short version is below. See [docs/setup-infra-tak.md](docs/setup-infra-tak.md) for the full guide, running a local test, operations and troubleshooting.

1. **Create a TAK user for the bridge in TAK Portal,** for example `crowdcad-bridge`, with a password. Add it to the TAK groups your responders use: the bridge only receives positions from groups it belongs to. No certificate download is needed.
2. **In CrowdCAD, go to Profile > Admin > TAK > Add TAK server.** Choose where the bridge runs (the TAK Server machine with Docker, or this computer for a test) and enter the TAK Server address, username and password, or paste the user's Enroll QR link. CrowdCAD then shows the exact commands to paste. They download the bridge, write its complete `.env`, and start it. Copy them right away: they're shown only once.
3. **Run the commands.** On first start the bridge enrolls with TAK Server (port 8446) for its own client certificate, saves it, and renews it before it expires. Then it streams positions over TLS (port 8089).
4. **Watch the checklist in CrowdCAD.** It shows whether the bridge signed in, connected to TAK, and is receiving positions, and explains any problem.

To check the TAK side alone, set `CROWDCAD_BACKEND=none`. The bridge then logs each position it receives (`"msg":"position"`) and writes nothing.

To set the bridge up by hand, copy `.env.example` to `.env` (every setting is described there), then run `docker compose up -d --build`. A client certificate bundle (`TAK_CLIENT_P12`) still works instead of enrollment.

`.env` and the bridge's data (the `tak-bridge-data` volume, or `data/` when run with Node) contain secrets. Both are excluded from git and from the Docker build context. Keep them readable only by the user that runs the bridge.

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
