import { supabase } from './supabase.js';

const signedUrlCache = new Map();

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

export async function setDayPhoto(dayRowId, userId, file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${dayRowId}.${ext}`;
  const { error: uploadError } = await supabase.storage.from('devotional-photos').upload(path, file, {
    upsert: true,
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
  signedUrlCache.delete(path);
  return { path, uploadedAt };
}

export async function removeDayPhoto(dayRowId, path) {
  if (path) {
    await supabase.storage.from('devotional-photos').remove([path]);
    signedUrlCache.delete(path);
  }
  const { error } = await supabase.from('devotional_days').update({
    photo_url: null,
    photo_uploaded_by: null,
    photo_uploaded_at: null,
  }).eq('id', dayRowId);
  if (error) throw error;
}
