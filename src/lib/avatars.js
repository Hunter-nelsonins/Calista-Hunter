import { supabase } from './supabase.js';

const signedUrlCache = new Map();

export function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

// Bucket is private, so every render resolves a short-lived signed URL.
// Cached per page load so the same person's photo isn't re-signed for every
// prayer/check-in/history row that mentions them.
export async function getAvatarUrl(path) {
  if (!path) return null;
  if (signedUrlCache.has(path)) return signedUrlCache.get(path);
  const promise = supabase.storage.from('avatars').createSignedUrl(path, 60 * 60)
    .then(({ data, error }) => (error ? null : data?.signedUrl || null));
  signedUrlCache.set(path, promise);
  return promise;
}

// Resolves avatar URLs for a list of {id, display_name, avatar_url} profiles
// and returns a map keyed by id: { display_name, avatarUrl }.
export async function buildProfileMap(profiles) {
  const map = {};
  await Promise.all((profiles || []).map(async (p) => {
    map[p.id] = { display_name: p.display_name, avatarUrl: await getAvatarUrl(p.avatar_url) };
  }));
  return map;
}

export function avatarHtml(profile, size = 32) {
  const name = profile?.display_name || 'Someone';
  const safeName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  if (profile?.avatarUrl) {
    return `<img class="avatar" style="width:${size}px;height:${size}px;" src="${profile.avatarUrl}" alt="${safeName}" title="${safeName}" />`;
  }
  const fontSize = Math.round(size * 0.4);
  return `<span class="avatar avatar-fallback" style="width:${size}px;height:${size}px;font-size:${fontSize}px;" title="${safeName}">${initials(name)}</span>`;
}

export async function setAvatar(userId, file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${userId}.${ext}`;
  const { error: uploadError } = await supabase.storage.from('avatars').upload(path, file, {
    upsert: true,
    contentType: file.type || 'image/jpeg',
  });
  if (uploadError) throw uploadError;
  const { error: updateError } = await supabase.from('profiles').update({ avatar_url: path }).eq('id', userId);
  if (updateError) throw updateError;
  signedUrlCache.delete(path);
  return path;
}
