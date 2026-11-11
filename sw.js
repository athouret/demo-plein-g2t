// Rend la démo installable sur Android et affiche un message clair quand le téléphone ne capte pas. Rien n'est gardé en mémoire.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plein G2T</title>' +
    '<body style="font-family:-apple-system,Segoe UI,sans-serif;padding:32px 24px;color:#111827;background:#F8FAFC"><h1 style="font-size:1.4rem">Pas de réseau</h1>' +
    '<p style="color:#6B7280;line-height:1.5">L’appli a besoin d’internet pour lire les prix des stations. Réessayez dès que le téléphone capte.</p>' +
    '<button onclick="location.reload()" style="margin-top:12px;padding:12px 18px;border:0;border-radius:10px;background:#0F2A4A;color:#fff;font-size:1rem">Réessayer</button></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
})
