'use strict';

// Resolves users against the guild/user API, not only the channel's message mention/cache.
// A name is returned only when it has one unambiguous exact match.
const SNOWFLAKE = /^\d{15,25}$/;
const mentionId = raw => {
  const value = String(raw ?? '').trim();
  const mention = value.match(/^<@!?(\d{15,25})>$/);
  if (mention) return mention[1];
  return SNOWFLAKE.test(value) ? value : null;
};
const valuesOf = collection => collection && typeof collection.values === 'function' ? [...collection.values()] : [];
const normalized = value => String(value ?? '').trim().replace(/^@/, '').toLocaleLowerCase('en-US');

function exactMemberMatches(members, raw) {
  const q = normalized(raw);
  if (!q) return [];
  return members.filter(member => {
    const user = member?.user;
    return [user?.username, user?.globalName, user?.tag, member?.displayName]
      .some(name => normalized(name) === q);
  });
}

async function resolveTargetUser(raw, { guild = null, client = null, mentions = null } = {}) {
  const input = String(raw ?? '').trim();
  if (!input) return null;
  const id = mentionId(input);
  if (id) {
    const mentioned = mentions?.get?.(id);
    if (mentioned) return mentioned;
    if (guild?.members) {
      const cachedMember = guild.members.cache?.get?.(id);
      if (cachedMember?.user) return cachedMember.user;
      const fetchedMember = await guild.members.fetch(id).catch(() => null);
      if (fetchedMember?.user) return fetchedMember.user;
    }
    const cachedUser = client?.users?.cache?.get?.(id);
    if (cachedUser) return cachedUser;
    return client?.users?.fetch ? client.users.fetch(id).catch(() => null) : null;
  }

  if (!guild?.members) return null;
  const cachedMembers = valuesOf(guild.members.cache);
  const cachedMatches = exactMemberMatches(cachedMembers, input);

  // Search the guild too: cache-only uniqueness is not enough to disambiguate uncached members.
  if (typeof guild.members.search === 'function') {
    const found = await guild.members.search({ query: input.slice(0, 100), limit: 10 }).catch(() => null);
    if (!found) return null; // fail closed instead of acting on a guessed target
    const foundMembers = valuesOf(found);
    if (foundMembers.length >= 10) return null; // the bounded result may have omitted a duplicate
    if (!foundMembers.length && Number(guild.memberCount) > cachedMembers.length) return null;
    const candidates = foundMembers.length ? foundMembers : cachedMembers;
    const matches = exactMemberMatches(candidates, input);
    const unique = [...new Map(matches.filter(m => m?.user?.id).map(m => [m.user.id, m])).values()];
    return unique.length === 1 ? unique[0].user : null;
  }

  // Without a guild search API, only trust the cache if it contains the entire guild.
  if (Number(guild.memberCount) > cachedMembers.length) return null;
  const uniqueCached = [...new Map(cachedMatches.filter(m => m?.user?.id).map(m => [m.user.id, m])).values()];
  return uniqueCached.length === 1 ? uniqueCached[0].user : null;
}

async function resolveTargetMember(raw, { guild = null, client = null, mentions = null } = {}) {
  if (!guild?.members) return null;
  const id = mentionId(raw);
  if (id) {
    const cached = guild.members.cache?.get?.(id);
    if (cached) return cached;
    return guild.members.fetch(id).catch(() => null);
  }
  const user = await resolveTargetUser(raw, { guild, client, mentions });
  if (!user) return null;
  return guild.members.cache?.get?.(user.id) || guild.members.fetch(user.id).catch(() => null);
}

module.exports = { resolveTargetUser, resolveTargetMember, _internals: { mentionId, exactMemberMatches } };
