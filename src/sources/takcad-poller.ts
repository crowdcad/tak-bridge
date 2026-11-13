// SPDX-License-Identifier: AGPL-3.0-only

import type { InboundEvent, InboundSource } from './types.js';

/**
 * Placeholder for a later TAK-CAD source. Not used in v1.
 *
 * TAK-CAD is a TAK Server plugin with a REST API, not a CoT stream. The
 * planned design:
 * - Requests go to the TAK Server API port (8443 by default), authenticated
 *   with the same TlsIdentity as the CoT stream.
 * - Endpoint: /Marti/api/plugins/tak.server.plugins.TakCadServerPlugin/submit
 *   with an `fn` parameter naming the operation.
 * - State is polled every 15 s, since the API does not push changes.
 * - The bridge's TAK user may need TAK-CAD permissions.
 *
 * Event kinds for TAK-CAD status get added to InboundEvent when this is built.
 * CrowdCAD must keep working when TAK-CAD is absent.
 */
export class TakCadPollerSource implements InboundSource {
  readonly name = 'takcad-poller';

  async start(_onEvent: (event: InboundEvent) => void): Promise<void> {
    throw new Error('TakCadPollerSource is not implemented yet');
  }

  async stop(): Promise<void> {}

  isConnected(): boolean {
    return false;
  }
}
