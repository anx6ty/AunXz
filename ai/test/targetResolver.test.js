'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTargetUser, resolveTargetMember, _internals } = require('../../targetResolver');

function member(id, username, displayName = username) {
  const user = { id, username, globalName: null, tag: `${username}#0001` };
  return { id, user, displayName };
}
function fakeGuild(members, remoteMembers = []) {
  const byId = new Map(members.map(m => [m.id, m]));
  return { members: {
    cache: byId,
    async fetch(value) { return byId.get(String(value)) || null; },
    async search({ query }) { const all = [...byId.values(), ...remoteMembers]; return new Map(all.filter(m => [m.user.username, m.user.globalName, m.user.tag, m.displayName].some(n => String(n || '').toLowerCase().includes(query.toLowerCase()))).map(m => [m.id, m])); }
  } };
}

test('parses IDs and standard Discord mention forms', () => {
  assert.equal(_internals.mentionId('123456789012345678'), '123456789012345678');
  assert.equal(_internals.mentionId('<@123456789012345678>'), '123456789012345678');
  assert.equal(_internals.mentionId('<@!123456789012345678>'), '123456789012345678');
  assert.equal(_internals.mentionId('almost-123456789012345678'), null);
});

test('resolves a member by ID even when they were not in the channel message cache', async () => {
  const target = member('123456789012345678', 'Target');
  const guild = fakeGuild([], [target]);
  guild.members.fetch = async id => id === target.id ? target : null;
  const user = await resolveTargetUser(`<@!${target.id}>`, { guild, client: {}, mentions: new Map() });
  assert.equal(user.id, target.id);
  const resolvedMember = await resolveTargetMember(target.id, { guild, client: {} });
  assert.equal(resolvedMember.id, target.id);
});

test('resolves one exact guild username or display name', async () => {
  const target = member('123456789012345678', 'ExactUser', 'Display Name');
  const guild = fakeGuild([target]);
  assert.equal((await resolveTargetUser('display name', { guild })).id, target.id);
  assert.equal((await resolveTargetUser('ExactUser', { guild })).id, target.id);
});

test('does not guess when names are ambiguous or a user is not in the guild', async () => {
  const a = member('123456789012345678', 'Same');
  const b = member('223456789012345678', 'Same');
  const guild = fakeGuild([a, b]);
  assert.equal(await resolveTargetUser('Same', { guild }), null);
  assert.equal(await resolveTargetMember('Same', { guild }), null);
});

test('can resolve a known user object by ID outside the guild without claiming membership', async () => {
  const user = { id: '123456789012345678', username: 'LeftServer' };
  const guild = fakeGuild([]);
  const client = { users: { cache: new Map(), async fetch(id) { return id === user.id ? user : null; } } };
  assert.equal((await resolveTargetUser(user.id, { guild, client })).id, user.id);
  assert.equal(await resolveTargetMember(user.id, { guild, client }), null);
});
