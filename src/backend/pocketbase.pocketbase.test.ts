// SPDX-License-Identifier: AGPL-3.0-only

import type PocketBase from 'pocketbase';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bridge } from '../bridge.js';
import { createLogger } from '../log.js';
import { Simulation } from '../sim/model.js';
import { clientFor, pocketbaseAvailable, startPocketBase, type LocalPocketBase } from '../testing/pocketbase.js';
import { PocketBaseAdapter } from './pocketbase.js';

/**
 * crowdcad/crowdcad's PocketBase TAK collections and rules (as created by
 * scripts/setup-pocketbase.js), and the PocketBase adapter end to end.
 */
const withPocketBase = pocketbaseAvailable() ? describe : describe.skip;
const log = createLogger('error', () => {});
const PW = 'test-password-123';
const center = { lat: 45.0012, lon: -100.0021 };

withPocketBase('PocketBase TAK rules and adapter', () => {
  let pb: LocalPocketBase;
  const ids: Record<string, string> = {};
  const as: Record<string, PocketBase> = {};
  const eventIds: Record<string, string> = {};

  async function rejects(p: Promise<unknown>): Promise<void> {
    await expect(p).rejects.toBeTruthy();
  }

  beforeAll(async () => {
    pb = await startPocketBase();
    const mk = async (key: string, extra: Record<string, unknown> = {}) => {
      const email = `${key.toLowerCase()}@tests.local`;
      const u = await pb.admin.collection('users').create({ email, password: PW, passwordConfirm: PW, ...extra });
      ids[key] = u.id;
      return email;
    };
    const emails = {
      ADM: await mk('ADM', { isAdmin: true }),
      OWN: await mk('OWN'),
      SH: await mk('SH'),
      STR: await mk('STR'),
      BR: await mk('BR', { role: 'bridge' }),
      BR2: await mk('BR2', { role: 'bridge' }),
    };
    for (const [k, e] of Object.entries(emails)) as[k] = await clientFor(pb.url, e, PW);

    await pb.admin.collection('tak_bridges').create({ bridgeUser: ids.BR, label: 'Main', createdBy: ids.ADM, allowedUsers: [ids.OWN], defaultHistoryMode: 'summary' });
    await pb.admin.collection('tak_bridges').create({ bridgeUser: ids.BR2, label: 'Other', createdBy: ids.ADM, allowedUsers: [], defaultHistoryMode: 'off' });

    const ev = async (key: string, data: Record<string, unknown>) => {
      eventIds[key] = (await pb.admin.collection('events').create({ name: key, ...data })).id;
    };
    await ev('E1', { userId: ids.OWN, sharedWith: [emails.SH], mapMode: 'tak', calls: [{ chiefComplaint: 'private' }] });
    await ev('E2', { userId: ids.OWN, mapMode: 'tak' });
    await ev('E3', { userId: ids.OWN, mapMode: 'tak' });
    await ev('E4', { userId: ids.OWN, mapMode: 'tak' });
    await ev('E5', { userId: ids.OWN, mapMode: 'tak' });
    await ev('STD', { userId: ids.OWN, sharedWith: [emails.SH] });
    const cfg = (e: string, over: Record<string, unknown> = {}) =>
      pb.admin.collection('tak_event_config').create({ event: eventIds[e], bridge: ids.BR, enabled: true, closed: false, historyMode: 'summary', ...over });
    await cfg('E1');
    await cfg('E3', { closed: true });
    await cfg('E4', { historyMode: 'off' });
    await cfg('E5');
  }, 120_000);

  afterAll(async () => pb?.stop());

  const live = (event: string, bridge: string, over: Record<string, unknown> = {}) => ({
    event: eventIds[event],
    bridge,
    deviceUid: 'DEV1',
    lat: 45.001,
    lon: -100.002,
    deviceTime: 1,
    receivedAt: 1,
    ...over,
  });

  describe('bridge accounts', () => {
    it('cannot read, list or write events, even shared ones', async () => {
      expect((await as.BR!.collection('events').getList(1, 50)).items).toHaveLength(0);
      await rejects(as.BR!.collection('events').getOne(eventIds.E1!));
      await rejects(as.BR!.collection('events').create({ userId: ids.BR, name: 'x' }));
      await rejects(as.BR!.collection('events').update(eventIds.E1!, { calls: [] }));
    });

    it('cannot edit bridge records, TAK config, links or mappings, or its own role', async () => {
      const mine = await as.BR!.collection('tak_bridges').getFirstListItem(`bridgeUser = "${ids.BR}"`);
      await rejects(as.BR!.collection('tak_bridges').update(mine.id, { label: 'x' }));
      await rejects(as.BR!.collection('tak_event_config').create({ event: eventIds.E2, bridge: ids.BR, enabled: true, closed: false, historyMode: 'summary' }));
      await rejects(as.BR!.collection('tak_device_links').create({ event: eventIds.E1, deviceUid: 'D', teamId: 't', linkedAt: 1, method: 'manual', linkedBy: ids.BR }));
      await rejects(as.BR!.collection('tak_device_mappings').create({ bridge: ids.BR, deviceUid: 'D', teamName: 'T', updatedBy: ids.BR }));
      await rejects(as.BR!.collection('users').update(ids.BR!, { role: '' }));
    });

    it('writes live positions only to linked, enabled, open events, as itself', async () => {
      await as.BR!.collection('tak_live').create(live('E1', ids.BR!));
      await rejects(as.BR!.collection('tak_live').create(live('E2', ids.BR!)));
      await rejects(as.BR!.collection('tak_live').create(live('E3', ids.BR!)));
      await rejects(as.BR!.collection('tak_live').create(live('E1', ids.BR2!, { deviceUid: 'DEV2' })));
      await rejects(as.BR2!.collection('tak_live').create(live('E1', ids.BR2!, { deviceUid: 'DEV3' })));
    });

    it('writes history only as the event records it', async () => {
      const seg = (e: string, s: string) => ({ event: eventIds[e], bridge: ids.BR, segmentId: s, windows: [] });
      await as.BR!.collection('tak_history').create(seg('E1', 'S1'));
      await rejects(as.BR!.collection('tak_history').create(seg('E4', 'S2')));
      await rejects(as.BR!.collection('tak_history_points').create({ event: eventIds.E1, bridge: ids.BR, segmentId: 'S1', chunk: 0, points: [] }));
    });
  });

  describe('admins, owners and dispatchers', () => {
    it('only admins create bridge records; allowed users see theirs', async () => {
      await rejects(as.OWN!.collection('tak_bridges').create({ bridgeUser: ids.STR, label: 'x', createdBy: ids.OWN, allowedUsers: [] }));
      const r = await as.ADM!.collection('tak_bridges').create({ bridgeUser: ids.STR, label: 'tmp', createdBy: ids.ADM, allowedUsers: [] });
      await as.ADM!.collection('tak_bridges').delete(r.id);
      const visible = await as.OWN!.collection('tak_bridges').getFullList();
      expect(visible.map((b) => b.bridgeUser)).toEqual([ids.BR]);
      expect(await as.STR!.collection('tak_bridges').getFullList()).toHaveLength(0);
    });

    it('a non-admin cannot make anyone a bridge account', async () => {
      await rejects(as.STR!.collection('users').update(ids.STR!, { role: 'bridge' }));
    });

    it('owners link only bridges they are allowed to use; others cannot manage config', async () => {
      await rejects(as.OWN!.collection('tak_event_config').create({ event: eventIds.E2, bridge: ids.BR2, enabled: true, closed: false, historyMode: 'summary' }));
      const c = await as.OWN!.collection('tak_event_config').create({ event: eventIds.E2, bridge: ids.BR, enabled: true, closed: false, historyMode: 'summary' });
      await rejects(as.SH!.collection('tak_event_config').update(c.id, { historyMode: 'off' }));
      await rejects(as.ADM!.collection('tak_event_config').update(c.id, { bridge: ids.BR2 }));
      await as.ADM!.collection('tak_event_config').update(c.id, { closed: true });
      await as.OWN!.collection('tak_event_config').delete(c.id);
    });

    it('dispatchers link devices as themselves; history is owner-only', async () => {
      await as.SH!.collection('tak_device_links').create({ event: eventIds.E1, deviceUid: 'D9', teamId: 't9', linkedAt: 1, method: 'manual', linkedBy: ids.SH });
      await rejects(as.SH!.collection('tak_device_links').create({ event: eventIds.E1, deviceUid: 'D8', teamId: 't8', linkedAt: 1, method: 'manual', linkedBy: ids.OWN }));
      expect((await as.OWN!.collection('tak_history').getFullList()).length).toBeGreaterThan(0);
      expect(await as.SH!.collection('tak_history').getFullList()).toHaveLength(0);
      expect((await as.SH!.collection('tak_live').getFullList()).length).toBeGreaterThan(0);
    });

    it('existing event rules still work, and mapMode is protected', async () => {
      expect((await as.SH!.collection('events').getFullList()).length).toBeGreaterThan(0);
      await as.SH!.collection('events').update(eventIds.STD!, { calls: [] });
      await rejects(as.SH!.collection('events').update(eventIds.STD!, { mapMode: 'tak' }));
      await as.OWN!.collection('events').update(eventIds.STD!, { mapMode: 'tak' });
    });
  });

  describe('PocketBaseAdapter + Bridge', () => {
    it('writes live docs and status for linked events, and clears them at close', async () => {
      const adapter = new PocketBaseAdapter({ url: pb.url, pollMs: 200 });
      const bridge = new Bridge({ adapter, log, version: 'test', takConnected: () => true, statusIntervalMs: 3_600_000 });
      await bridge.start('br@tests.local', PW);
      expect(bridge.linkedEvents.map((e) => e.eventId).sort()).toEqual([eventIds.E1, eventIds.E3, eventIds.E4, eventIds.E5].sort());

      const sim = new Simulation({ devices: 3, startTime: Date.now(), center });
      for (const f of sim.fixesBetween(Date.now() + 2 * 60_000)) bridge.handlePosition({ ...f, receivedAt: Date.now() });
      await bridge.flush();
      expect(bridge.stats.writeErrors).toBe(0);

      const e5 = await pb.admin.collection('tak_live').getFullList({ filter: `event = "${eventIds.E5}"` });
      expect(e5.map((r) => r.deviceUid).sort()).toEqual(['SIM-001', 'SIM-002', 'SIM-003']);
      expect(e5[0]!.bridge).toBe(ids.BR);
      expect(await pb.admin.collection('tak_live').getFullList({ filter: `event = "${eventIds.E3}"` })).toHaveLength(0);
      expect((await pb.admin.collection('tak_bridge_status').getFullList()).length).toBe(1);

      const cfg = await pb.admin.collection('tak_event_config').getFirstListItem(`event = "${eventIds.E5}"`);
      await pb.admin.collection('tak_event_config').update(cfg.id, { closed: true });
      const deadline = Date.now() + 10_000;
      while ((await pb.admin.collection('tak_live').getFullList({ filter: `event = "${eventIds.E5}"` })).length > 0) {
        if (Date.now() > deadline) throw new Error('live docs were not cleared at close');
        await new Promise((r) => setTimeout(r, 200));
      }
      await bridge.stop();
      await adapter.close();
    });

    it('is refused once its tak_bridges record is deleted (revocation)', async () => {
      const rec = await pb.admin.collection('tak_bridges').getFirstListItem(`bridgeUser = "${ids.BR}"`);
      await pb.admin.collection('tak_bridges').delete(rec.id);
      await rejects(as.BR!.collection('tak_live').create(live('E1', ids.BR!, { deviceUid: 'DEV7' })));
    });
  });
});
