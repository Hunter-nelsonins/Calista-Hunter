import { supabase } from './supabase.js';

const signedUrlCache = new Map();

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

// Bucket is private, so every render resolves a short-lived signed URL,
// cached per page load the same way avatars are.
export async function getDayPhotoUrl(path) {
  if (!path) return null;
  if (signedUrlCache.has(path)) return signedUrlCache.get(path);
  const promise = supabase.storage.from('devotional-photos').createSignedUrl(path, 60 * 60)
    .then(({ data, error }) => (error ? null : data?.signedUrl || null));
  signedUrlCache.set(path, promise);
  return promise;
}

function checkFile(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  const looksLikeImage = type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif)$/.test(name);
  if (!looksLikeImage) throw new Error('Please choose a photo (JPEG, PNG, WebP or an iPhone photo).');
  if (file.size > MAX_PHOTO_BYTES) throw new Error('That photo is larger than 25 MB. Please choose a smaller one.');
}

// Every upload gets its OWN new storage name. An earlier photo's file is never overwritten, so a
// replaced or removed picture is always still recoverable from storage.
export async function setDayPhoto(dayRowId, userId, file) {
  checkFile(file);
  const rawExt = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  const path = `${dayRowId}/${Date.now()}.${rawExt}`;
  const { error: uploadError } = await supabase.storage.from('devotional-photos').upload(path, file, {
    upsert: false,
    contentType: file.type || 'image/jpeg',
  });
  if (uploadError) throw uploadError;
  const uploadedAt = new Date().toISOString();
  const { error: updateError } = await supabase.from('devotional_days').update({
    photo_url: path,
    photo_uploaded_by: userId,
    photo_uploaded_at: uploadedAt,
  }).eq('id', dayRowId);
  if (updateError) throw updateError;
  return { path, uploadedAt };
}

// "Removing" a photo only detaches it from the day. The stored file is deliberately kept.
export async function removeDayPhoto(dayRowId) {
  const { error } = await supabase.from('devotional_days').update({
    photo_url: null,
    photo_uploaded_by: null,
    photo_uploaded_at: null,
  }).eq('id', dayRowId);
  if (error) throw error;
}

// Optional caption + shared memory (new columns; only used when they exist).
export async function saveDayMemory(dayRowId, { caption, memory }) {
  const patch = {};
  if (caption !== undefined) patch.photo_caption = caption.trim() || null;
  if (memory !== undefined) patch.shared_memory = memory.trim() || null;
  const { error } = await supabase.from('devotional_days').update(patch).eq('id', dayRowId);
  if (error) throw error;
}
