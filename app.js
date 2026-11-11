// Plein G2T — démonstration autonome de l'appli carburant des chauffeurs.
// Tout se passe dans le téléphone : prix officiels (prix-carburants.gouv.fr), enseignes (annuaire prix-carburants.2aaz.fr)
// et itinéraires (IGN) sont lus en direct. Aucun serveur, aucun compte, aucune donnée enregistrée ailleurs que sur le téléphone.
import { allegerTrace, carteLimitee, classer, ENSEIGNES, evaluer, jalons, trajetPonctuel } from './carburant.js'

// ——— Outils ———
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const prixL = (n) => `${n.toLocaleString('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} €`
const euros = (n) => `${Math.round(n).toLocaleString('fr-FR')} €`
const km = (n) => (n < 10 ? n.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : Math.round(n).toLocaleString('fr-FR'))
const duree = (min) => { const m = Math.round(min); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` }
const heure = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
const aujourdhui = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
const depuis = (iso) => {
  const h = (Date.now() - Date.parse(iso)) / 3_600_000
  if (h < 1) return 'il y a moins d’une heure'
  if (h < 48) return `il y a ${Math.round(h)} h`
  return `le ${new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })}`
}
const lire = (cle, defaut) => { try { const v = localStorage.getItem(cle); return v ? JSON.parse(v) : defaut } catch { return defaut } }
const ecrire = (cle, v) => { try { localStorage.setItem(cle, JSON.stringify(v)) } catch { /* navigation privée */ } }
const nombre = (s) => { const t = String(s).replace(/[\s€]/g, '').replace(',', '.'); return t ? Number(t) : null }

// ——— Le camion de démonstration (réglable depuis « Réglages de la démo ») ———
const CARTES = {
  total: { nom: 'Carte TotalEnergies', enseignes: ['total', 'totalaccess', 'elan'] },
  eni: { nom: 'Carte ENI', enseignes: ['eni', 'agip'] },
  esso: { nom: 'Carte Esso', enseignes: ['esso', 'essoexpress'] },
  avia: { nom: 'Carte Avia', enseignes: ['avia', 'aviaxpress'] },
  toutes: { nom: 'Toutes stations (CB, DKV, UTA…)', enseignes: [], toutes: true },
}
const REGLAGES_DEFAUT = { carte: 'total', remise: 0, reservoir: 400, conso: 33, poidsLourds: true }
let reglages = { ...REGLAGES_DEFAUT, ...lire('g2t:reglages', {}) }
const profil = () => {
  const c = CARTES[reglages.carte] ?? CARTES.total
  return {
    plaque: 'Démo', libelle: 'Camion de démonstration', categorie: 'camion',
    reservoir: reglages.reservoir, conso: reglages.conso, poidsLourds: reglages.poidsLourds,
    cartes: [{ id: reglages.carte, nom: c.nom, enseignes: c.enseignes, toutes: Boolean(c.toutes), remise: (reglages.remise || 0) / 100 }],
    reserveKm: 50, detourMaxKm: 15, coutHeure: 0,
  }
}

// ——— Sources (appelées directement depuis le téléphone) ———
const PRIX = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/exports/json'
const ITINERAIRE = 'https://data.geopf.fr/navigation/itineraire'
const ANNUAIRE = 'https://api.prix-carburants.2aaz.fr/station/'
const ADRESSES = 'https://data.geopf.fr/geocodage/search'

async function stationsDans(centres, rayonKm) {
  const paquets = []
  for (let i = 0; i < centres.length; i += 25) paquets.push(centres.slice(i, i + 25))
  const r = Math.round(rayonKm * 10) / 10
  const lots = await Promise.all(paquets.map(async (paquet) => {
    const cercles = paquet.map(([lon, lat]) => `within_distance(geom, geom'POINT(${lon.toFixed(5)} ${lat.toFixed(5)})', ${r}km)`).join(' or ')
    const q = new URLSearchParams({ where: `gazole_prix is not null and (${cercles})`, select: 'id,geom,gazole_prix,gazole_maj,gazole_rupture_type,adresse,ville,cp,pop,services_service,horaires_automate_24_24,horaires' })
    const rep = await fetch(`${PRIX}?${q}`, { signal: AbortSignal.timeout(15000) })
    if (!rep.ok) throw new Error(`Flux des prix : ${rep.status}`)
    return rep.json()
  }))
  const vues = new Map()
  for (const l of lots.flat()) {
    if (vues.has(l.id) || !l.geom || !l.gazole_prix || !l.gazole_maj || l.gazole_rupture_type) continue
    vues.set(l.id, {
      id: l.id, position: [l.geom.lon, l.geom.lat], prix: l.gazole_prix, maj: l.gazole_maj, adresse: l.adresse ?? '', ville: l.ville ?? '', cp: l.cp ?? '',
      poidsLourds: (l.services_service ?? []).includes('Piste poids lourds'), automate: l.horaires_automate_24_24 === 'Oui', autoroute: l.pop === 'A', horaires: l.horaires,
    })
  }
  return [...vues.values()]
}

async function itineraire(points) {
  const p = (x) => `${x[0].toFixed(6)},${x[1].toFixed(6)}`
  const q = new URLSearchParams({ resource: 'bdtopo-osrm', profile: 'car', optimization: 'fastest', start: p(points[0]), end: p(points.at(-1)), geometryFormat: 'geojson', getSteps: 'false', getBbox: 'false', distanceUnit: 'kilometer', timeUnit: 'minute' })
  if (points.length > 2) q.set('intermediates', points.slice(1, -1).map(p).join('|'))
  const rep = await fetch(`${ITINERAIRE}?${q}`, { signal: AbortSignal.timeout(15000) })
  if (!rep.ok) throw new Error(`Itinéraire : ${rep.status}`)
  const d = await rep.json()
  return { km: d.distance, minutes: d.duration, coords: d.geometry.coordinates, portions: (d.portions ?? []).map((x) => ({ km: x.distance, minutes: x.duration })) }
}

const enseignes = new Map(lire('g2t:enseignes', []))
async function enseigneDe(id) {
  if (enseignes.has(id)) return { lu: true, ...enseignes.get(id) }
  const rien = { enseigne: null, nomEnseigne: null, nom: null }
  try {
    const rep = await fetch(`${ANNUAIRE}${id}`, { signal: AbortSignal.timeout(6000) })
    if (rep.status === 404) return { lu: true, ...rien }
    if (!rep.ok) return { lu: false, ...rien }
    const d = await rep.json()
    const court = d.Brand?.shortName && /^[a-z0-9]{1,40}$/.test(d.Brand.shortName) ? d.Brand.shortName : null
    const e = { enseigne: court, nomEnseigne: d.Brand?.name ?? (court ? ENSEIGNES[court] ?? null : null), nom: d.name?.trim() || null }
    enseignes.set(id, e)
    return { lu: true, ...e }
  } catch {
    return { lu: false, ...rien }
  }
}

const MAX_ANNUAIRE = 60, VOULUES = 6, DETOUR_AUTOUR = 30

/** Le même calcul que l'appli : stations à portée, enseignes (carte du camion), puis détour réel des meilleures. */
async function conseiller(profilBase, demande) {
  const maintenant = new Date()
  const saisie = { autonomieKm: demande.autonomieKm, maintenant }
  const urgence = demande.autonomieKm <= profilBase.reserveKm
  let p = urgence ? { ...profilBase, reserveKm: 0 } : profilBase
  const portee = demande.autonomieKm - p.reserveKm
  let trajet, base = null, centres, rayon
  if (demande.arrivee) {
    base = await itineraire([demande.depart, demande.arrivee])
    trajet = { trace: allegerTrace(base.coords), km: base.km, minutes: base.minutes }
    rayon = Math.min(12, p.detourMaxKm / 2 / 1.35 + 1)
    centres = portee > 0 ? jalons(trajet.trace, rayon, Math.min(portee, base.km)) : []
  } else {
    trajet = trajetPonctuel(demande.depart)
    p = { ...p, detourMaxKm: Math.max(p.detourMaxKm, DETOUR_AUTOUR) }
    rayon = Math.max(1, Math.min(portee / 1.35, p.detourMaxKm / 2 / 1.35))
    centres = portee > 0 ? [demande.depart] : []
  }
  const resultat = {
    mode: base ? 'trajet' : 'autour', urgence, enseignesInconnues: false, trajet: base ? { km: base.km, minutes: base.minutes } : null,
    arriveSansPlein: Boolean(base && !urgence && portee >= base.km), resteALArrivee: base ? demande.autonomieKm - base.km : null,
    meilleures: [], horsCarte: null, prixMoyen: null, examinees: 0, portee,
  }
  if (!centres.length) return resultat
  const stations = await stationsDans(centres, rayon)

  let estimes = stations.map((s) => evaluer(s, p, trajet, saisie)).filter(Boolean).sort(classer)
  const prixMoyen = estimes.length ? estimes.reduce((s, c) => s + c.station.prix, 0) / estimes.length : null

  let limitee = carteLimitee(p.cartes)
  const remiseMax = Math.max(0, ...p.cartes.map((c) => c.remise))
  const connues = new Map()
  for (let i = 0; i < estimes.length && connues.size < MAX_ANNUAIRE; i += 10) {
    const lot = estimes.slice(i, i + 10).map((c) => c.station)
    const lus = await Promise.all(lot.map(async (s) => ({ s, e: await enseigneDe(s.id) })))
    if (i === 0 && lus.every((x) => !x.e.lu)) {
      resultat.enseignesInconnues = limitee
      if (limitee) { limitee = false; p = { ...p, cartes: [{ id: 'a-verifier', nom: 'Carte à vérifier sur place', enseignes: [], toutes: true, remise: 0 }] } }
      break
    }
    for (const { s, e } of lus) connues.set(s.id, { ...s, enseigne: e.enseigne, nomEnseigne: e.nomEnseigne, nom: e.nom })
    const retenus = [...connues.values()].map((s) => evaluer(s, p, trajet, saisie)).filter((c) => c && (!limitee || c.carte)).sort(classer)
    const suivant = estimes[i + 10]
    if (retenus.length >= VOULUES && (!suivant || suivant.prixEffectif - remiseMax >= retenus[VOULUES - 1].prixEffectif)) break
    if (!limitee && !remiseMax && i + 10 >= VOULUES) break
  }
  ecrire('g2t:enseignes', [...enseignes].slice(-800))
  estimes = estimes.map((c) => evaluer(connues.get(c.station.id) ?? c.station, p, trajet, saisie)).sort(classer)
  const acceptees = (cs) => cs.filter((c) => !limitee || c.carte)

  const calcules = new Map()
  const recalculer = async (c) => {
    try {
      if (base && demande.arrivee) {
        const it = await itineraire([demande.depart, c.station.position, demande.arrivee])
        const kmD = Math.max(0, it.km - base.km), min = Math.max(0, it.minutes - base.minutes)
        const aller = it.portions[0]?.km ?? c.kmDepuisDepart
        return evaluer(c.station, p, trajet, saisie, { km: kmD, min, kmDepuisDepart: Math.max(0, aller - kmD / 2) })
      }
      const it = await itineraire([demande.depart, c.station.position])
      return evaluer(c.station, p, trajet, saisie, { km: 2 * it.km, min: 2 * it.minutes, kmDepuisDepart: 0 })
    } catch {
      return c
    }
  }
  for (let tour = 0; tour < 2; tour++) {
    const actuels = acceptees(estimes.map((c) => (calcules.has(c.station.id) ? calcules.get(c.station.id) : c)).filter(Boolean)).sort(classer)
    const aFaire = actuels.slice(0, 4).filter((c) => !calcules.has(c.station.id))
    if (!aFaire.length) break
    for (let i = 0; i < aFaire.length; i += 2) {
      const faits = await Promise.all(aFaire.slice(i, i + 2).map(recalculer))
      aFaire.slice(i, i + 2).forEach((c, j) => calcules.set(c.station.id, faits[j]))
    }
  }
  const finaux = estimes.map((c) => (calcules.has(c.station.id) ? calcules.get(c.station.id) : c)).filter(Boolean).sort(classer)
  const meilleures = acceptees(finaux).slice(0, 5)
  const hors = limitee ? finaux.find((c) => !c.carte && c.station.enseigne) ?? null : null
  const montrerHors = hors && (!meilleures.length || hors.prixEffectif < meilleures[0].prixEffectif - 0.03)
  const versProposition = (c) => {
    const s = c.station
    return {
      id: s.id, nom: s.nom ?? '', enseigne: s.nomEnseigne ?? (s.enseigne ? ENSEIGNES[s.enseigne] ?? s.enseigne : null),
      adresse: s.adresse, ville: [s.cp, s.ville].filter(Boolean).join(' '), position: s.position, prix: s.prix, prixPaye: c.prixPaye, remise: c.carte?.remise ?? 0,
      litres: Math.round(c.litres), detourKm: c.detourKm, detourMin: c.detourMin, detourCalcule: c.detourCalcule, kmDepuisDepart: c.kmDepuisDepart,
      prixEffectif: c.prixEffectif, coutPlein: c.prixPaye * c.litres + c.coutDetour, economie: prixMoyen !== null ? (prixMoyen - c.prixEffectif) * c.litres : null,
      arrivee: c.arrivee.toISOString(), ouverte: c.ouverte, prixAncien: c.prixAncien, maj: s.maj, autoroute: s.autoroute,
    }
  }
  return { ...resultat, meilleures: meilleures.map(versProposition), horsCarte: montrerHors ? versProposition(hors) : null, prixMoyen, examinees: estimes.length }
}

// ——— L'écran ———
const etat = { onglet: 'station', position: null, etatPosition: 'attente', departManuel: null, destination: null, autour: false, autonomie: '', enCours: false, erreur: null, conseil: null, recents: lire('g2t:recents', []) }

function localiser() {
  return new Promise((ok) => {
    if (!('geolocation' in navigator)) { etat.etatPosition = 'indisponible'; afficherDepart(); ok(null); return }
    navigator.geolocation.getCurrentPosition(
      (p) => { etat.position = { point: [p.coords.longitude, p.coords.latitude], precision: p.coords.accuracy, le: Date.now() }; etat.etatPosition = 'ok'; afficherDepart(); ok(etat.position) },
      (e) => { etat.etatPosition = e.code === e.PERMISSION_DENIED ? 'refus' : 'indisponible'; afficherDepart(); ok(null) },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
    )
  })
}

/** Un champ d'adresse avec propositions pendant la frappe (base adresse nationale, IGN). */
function champAdresse(conteneur, placeholder, onChoix) {
  conteneur.innerHTML = `<div class="recherche"><input class="champ grand" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="search"><ul class="propositions" hidden></ul></div>`
  const input = conteneur.querySelector('input'), liste = conteneur.querySelector('ul')
  let minuterie, controle
  input.addEventListener('input', () => {
    clearTimeout(minuterie); controle?.abort()
    const texte = input.value.trim()
    if (texte.length < 3) { liste.hidden = true; return }
    minuterie = setTimeout(async () => {
      controle = new AbortController()
      try {
        const rep = await fetch(`${ADRESSES}?${new URLSearchParams({ q: texte, limit: '6', autocomplete: '1' })}`, { signal: controle.signal })
        const d = await rep.json()
        const adresses = d.features.filter((f) => f.properties.label).map((f) => ({ label: f.properties.label, point: f.geometry.coordinates }))
        liste.innerHTML = adresses.map((a, i) => `<li><button type="button" data-i="${i}">📍 ${esc(a.label)}</button></li>`).join('')
        liste.hidden = !adresses.length
        liste.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onChoix(adresses[Number(b.dataset.i)])))
      } catch { /* frappe suivante */ }
    }, 350)
  })
}

function afficherEntete() {
  const p = profil()
  $('#puces').innerHTML = p.cartes.map((c) => `<span class="puce-entete">💳 ${esc(c.nom)}${c.remise ? ` · −${(c.remise * 100).toLocaleString('fr-FR')} ct/L` : ''}</span>`).join('')
    + (p.poidsLourds ? '<span class="puce-entete">Stations avec piste poids lourds</span>' : '')
  document.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.onglet === etat.onglet)))
  $('#station').hidden = etat.onglet !== 'station'
  $('#ticket').hidden = etat.onglet !== 'ticket'
}

function afficherDepart() {
  const z = $('#depart')
  if (etat.departManuel) {
    z.innerHTML = `<div class="choisi">📍 <span>${esc(etat.departManuel.label)}</span><button type="button" aria-label="Revenir au GPS">✕</button></div>`
    z.querySelector('button').addEventListener('click', () => { etat.departManuel = null; localiser() })
  } else if (etat.etatPosition === 'ok') {
    z.innerHTML = `<div class="choisi ok">◎ <span>Ma position (à ${Math.max(5, Math.round(etat.position.precision))} m près)</span><button type="button" class="lien">Actualiser</button></div>`
    z.querySelector('button').addEventListener('click', localiser)
  } else if (etat.etatPosition === 'attente') {
    z.innerHTML = '<div class="choisi attente">◎ Recherche de votre position…</div>'
  } else {
    z.innerHTML = `<p class="alerte avert">${etat.etatPosition === 'refus' ? 'La localisation est refusée. Autorisez-la dans les réglages du téléphone, ou saisissez votre adresse de départ.' : 'Position introuvable pour le moment. Réessayez, ou saisissez votre adresse de départ.'}</p>
      <button type="button" class="btn fin" id="reessayer">◎ Réessayer</button><div id="champ-depart"></div>`
    z.querySelector('#reessayer').addEventListener('click', localiser)
    champAdresse(z.querySelector('#champ-depart'), 'Adresse de départ', (a) => { etat.departManuel = a; etat.conseil = null; afficherDepart(); afficherResultats() })
  }
}

function afficherDestination() {
  const z = $('#destination')
  if (etat.destination) {
    z.innerHTML = `<div class="choisi fort">📍 <span>${esc(etat.destination.label)}</span><button type="button" aria-label="Changer de destination">✕</button></div>`
    z.querySelector('button').addEventListener('click', () => { etat.destination = null; etat.conseil = null; afficherDestination(); afficherResultats() })
    return
  }
  z.innerHTML = `<div id="champ-destination"></div><div class="puces"><button type="button" class="puce ${etat.autour ? 'on' : ''}" id="autour">◎ Autour de moi</button>
    ${etat.autour ? '' : etat.recents.map((r, i) => `<button type="button" class="puce" data-r="${i}">${esc(r.label)}</button>`).join('')}</div>`
  if (!etat.autour) champAdresse(z.querySelector('#champ-destination'), 'Chantier, ville, adresse…', choisirDestination)
  z.querySelector('#autour').addEventListener('click', () => { etat.autour = !etat.autour; etat.conseil = null; afficherDestination(); afficherResultats() })
  z.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => choisirDestination(etat.recents[Number(b.dataset.r)])))
}

function choisirDestination(a) {
  etat.destination = a; etat.autour = false; etat.conseil = null
  etat.recents = [a, ...etat.recents.filter((x) => x.label !== a.label)].slice(0, 5)
  ecrire('g2t:recents', etat.recents)
  afficherDestination(); afficherResultats()
}

async function chercher() {
  etat.erreur = null
  const auto = nombre(etat.autonomie)
  if (auto === null || !Number.isFinite(auto) || auto < 0) etat.erreur = 'Indiquez l’autonomie restante en km (affichée au tableau de bord).'
  else if (!etat.destination && !etat.autour) etat.erreur = 'Indiquez où vous allez, ou choisissez « Autour de moi ».'
  if (etat.erreur) { afficherBouton(); return }
  etat.enCours = true; afficherBouton()
  try {
    const pos = etat.departManuel ? null : (etat.position && Date.now() - etat.position.le < 60000 ? etat.position : await localiser())
    const depart = etat.departManuel?.point ?? pos?.point
    if (!depart) { etat.erreur = 'Position inconnue : autorisez la localisation, ou saisissez votre adresse de départ.'; return }
    etat.conseil = await conseiller(profil(), { depart, arrivee: etat.autour ? null : etat.destination.point, autonomieKm: auto })
    afficherResultats()
    setTimeout(() => $('#resultats').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  } catch (e) {
    console.error(e)
    etat.erreur = 'Les prix ou l’itinéraire ne répondent pas pour le moment. Réessayez dans un instant.'
  } finally {
    etat.enCours = false; afficherBouton()
  }
}

function afficherBouton() {
  $('#erreur').hidden = !etat.erreur
  $('#erreur').textContent = etat.erreur ?? ''
  const b = $('#chercher')
  b.disabled = etat.enCours
  b.innerHTML = etat.enCours ? '<span class="pulse">⛽</span> Recherche des prix…' : '⛽ Trouver où faire le plein'
}

function frise(c) {
  const total = c.trajet?.km ?? 0
  if (!total || !c.meilleures.length) return ''
  const x = (k) => 14 + (Math.min(k, total) / total) * 312
  const limite = c.portee < total ? x(c.portee) : null
  const points = c.meilleures.map((p, i) => ({ p, i })).reverse().map(({ p, i }) => `<g><circle cx="${x(p.kmDepuisDepart)}" cy="26" r="${i === 0 ? 9 : 7}" fill="${i === 0 ? 'var(--accent)' : '#fff'}" stroke="${i === 0 ? 'var(--accent)' : 'var(--ink-2)'}" stroke-width="1.5"/>
    <text x="${x(p.kmDepuisDepart)}" y="29.5" text-anchor="middle" font-size="${i === 0 ? 10 : 9}" font-weight="600" fill="${i === 0 ? '#fff' : 'var(--ink)'}">${i + 1}</text></g>`).join('')
  return `<svg viewBox="0 0 340 58" class="frise" role="img" aria-label="Position des stations sur le trajet">
    <line x1="14" x2="326" y1="26" y2="26" stroke="var(--line)" stroke-width="6" stroke-linecap="round"/>
    ${limite ? `<line x1="${limite}" x2="326" y1="26" y2="26" stroke="var(--bad-l)" stroke-width="6" stroke-linecap="round"/><line x1="${limite}" x2="${limite}" y1="14" y2="38" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="3 2"/><text x="${limite}" y="52" text-anchor="middle" font-size="9" fill="var(--bad)">réserve</text>` : ''}
    <circle cx="14" cy="26" r="5" fill="var(--ink)"/><circle cx="326" cy="26" r="5" fill="var(--ink)"/>
    <text x="14" y="52" font-size="9" fill="var(--mut)">Départ</text><text x="326" y="52" font-size="9" text-anchor="end" fill="var(--mut)">Arrivée</text>${points}</svg>`
}

function carteStation(p, rang, meilleur, destination) {
  const [lon, lat] = p.position
  const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`
  const gmaps = destination
    ? `https://www.google.com/maps/dir/?api=1&destination=${destination.point[1]},${destination.point[0]}&waypoints=${lat},${lon}&travelmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`
  const premier = rang === 1
  const enPlus = (p.prixEffectif - meilleur.prixEffectif) * p.litres
  const nom = p.nom && p.nom.toUpperCase() !== (p.enseigne ?? '').toUpperCase() ? `<span class="mut"> · ${esc(p.nom)}</span>` : ''
  return `<article class="carte station ${premier ? 'premier' : ''}">
    <div class="ligne"><span class="rang">${rang}</span>
      <div class="titre">${premier ? '<div class="etiquette accent">Le meilleur choix</div>' : ''}<div class="nom">${esc(p.enseigne ?? 'Station')}${nom}</div><div class="mut petit">${esc(p.adresse)}, ${esc(p.ville)}</div></div>
      <div class="prix"><div>${prixL(p.prixPaye)}</div><small>${p.remise ? `pompe ${prixL(p.prix)} − remise` : 'le litre'}</small></div></div>
    <div class="cases"><div><small>Où</small><b>${p.kmDepuisDepart < 0.5 && !p.detourKm ? 'tout près' : `à ${km(p.kmDepuisDepart + p.detourKm / 2)} km`}</b><small>${p.detourKm < 0.5 ? 'sur votre route' : `détour ${p.detourCalcule ? '' : '≈ '}+${km(p.detourKm)} km, +${duree(p.detourMin)}`}</small></div>
      <div><small>Le plein</small><b>≈ ${p.litres} L · ${euros(p.coutPlein)}</b><small>${premier ? (p.economie !== null && p.economie > 1 ? `≈ ${euros(p.economie)} d’économie` : 'détour compris') : enPlus >= 1 ? `≈ ${euros(enPlus)} de plus que le n° 1` : 'comme le n° 1'}</small></div></div>
    <div class="puces"><span class="pastille ${p.ouverte === null ? 'avert' : 'ok'}">🕒 ${p.ouverte === null ? 'horaires non déclarés' : `ouverte à votre arrivée (≈ ${heure(p.arrivee)})`}</span>
      ${p.autoroute ? '<span class="pastille">autoroute</span>' : ''}<span class="pastille ${p.prixAncien ? 'avert' : ''}">prix ${depuis(p.maj)}</span></div>
    <div class="deux"><a class="btn ${premier ? 'plein' : 'fin'}" href="${waze}" target="_blank" rel="noopener noreferrer">➤ Y aller (Waze)</a><a class="btn fin" href="${gmaps}" target="_blank" rel="noopener noreferrer">Google Maps →</a></div>
  </article>`
}

function afficherResultats() {
  const z = $('#resultats'), c = etat.conseil
  if (!c) { z.innerHTML = ''; return }
  const p = profil()
  const limitee = p.cartes.length && !p.cartes.some((x) => x.toutes)
  let h = ''
  if (c.trajet) {
    h += `<div class="carte"><div class="entre"><b>Trajet : ${km(c.trajet.km)} km · ${duree(c.trajet.minutes)}</b><span class="mut petit">${c.examinees} station${c.examinees > 1 ? 's' : ''} à portée</span></div>
      ${c.arriveSansPlein ? `<p class="alerte bien">Vous pouvez arriver sans faire le plein (il restera environ ${km(c.resteALArrivee ?? 0)} km d’autonomie). Si vous voulez remplir en route, voici le meilleur choix.</p>` : ''}${frise(c)}</div>`
  }
  if (c.urgence) h += `<p class="alerte mal">Réserve entamée (moins de ${p.reserveKm} km d’autonomie) : arrêtez-vous au plus vite. Voici les stations que vous pouvez encore atteindre.</p>`
  if (c.enseignesInconnues) h += '<p class="alerte avert">L’annuaire des enseignes ne répond pas : les stations sont proposées sans savoir si votre carte y passe. Vérifiez l’enseigne avant d’y aller.</p>'
  if (c.portee <= 0) h += '<p class="carte mal">Plus d’autonomie : arrêtez-vous et prévenez le bureau.</p>'
  else if (!c.meilleures.length) h += `<p class="carte">Aucune station ${limitee ? 'acceptant votre carte ' : ''}${p.poidsLourds ? 'avec piste poids lourds ' : ''}n’est à portée${c.trajet ? ` à moins de ${p.detourMaxKm} km de détour` : ''}. ${c.arriveSansPlein ? 'Faites le plein après votre arrivée.' : 'Essayez « Autour de moi », ou prévenez le bureau.'}</p>`
  else h += c.meilleures.map((s, i) => carteStation(s, i + 1, c.meilleures[0], etat.autour ? null : etat.destination)).join('')
  if (c.horsCarte) h += `<div class="pointilles"><b>Hors de votre carte :</b> ${esc(c.horsCarte.enseigne ?? 'une station')} à ${esc(c.horsCarte.ville)} affiche ${prixL(c.horsCarte.prix)}. À ne faire qu’avec l’accord du bureau.</div>`
  if (c.meilleures.length) h += '<p class="note"><b>Après le plein :</b> prenez le ticket en photo dans l’onglet « Photo du ticket ». Il part au bureau et se range tout seul avec la banque.</p>'
  if (c.prixMoyen) h += `<p class="mut petit">Prix moyen des stations à portée : ${prixL(c.prixMoyen)} le litre. L’économie est comptée par rapport à ce prix moyen, détour compris.</p>`
  z.innerHTML = h
}

// ——— Onglet « Photo du ticket » (démonstration : rien n'est envoyé) ———
async function reduire(f) {
  const image = await createImageBitmap(f).catch(() => null)
  if (!image) return f
  const echelle = Math.min(1, 1800 / Math.max(image.width, image.height))
  const toile = document.createElement('canvas')
  toile.width = Math.round(image.width * echelle); toile.height = Math.round(image.height * echelle)
  toile.getContext('2d').drawImage(image, 0, 0, toile.width, toile.height)
  return new Promise((ok) => toile.toBlob((b) => ok(b ?? f), 'image/jpeg', 0.85))
}

function ticketChoix() {
  $('#ticket').innerHTML = `<div class="carte"><h2>Ticket de plein</h2><p class="mut">Posez le ticket à plat, bien éclairé, en entier dans la photo. Il part directement au bureau.</p>
    <button type="button" class="btn plein tres-grand" id="appareil">📷 Prendre le ticket en photo</button><button type="button" class="btn fin" id="galerie">🖼 Choisir une photo déjà prise</button>
    <input type="file" accept="image/*" capture="environment" id="f-appareil" hidden><input type="file" accept="image/*" id="f-galerie" hidden></div>`
  $('#appareil').addEventListener('click', () => $('#f-appareil').click())
  $('#galerie').addEventListener('click', () => $('#f-galerie').click())
  for (const id of ['#f-appareil', '#f-galerie']) $(id).addEventListener('change', async (e) => { const f = e.target.files?.[0]; if (f) ticketConfirmer(URL.createObjectURL(await reduire(f))) })
}

function ticketConfirmer(apercu) {
  $('#ticket').innerHTML = `<div class="carte"><div class="ligne"><img src="${apercu}" alt="Photo du ticket" class="vignette"><div><b>Vérifiez ce qui a été lu</b>
      <p class="mut petit">En service, l’IA lit le ticket et remplit ces champs toute seule. Dans cette démonstration, saisissez-les.</p></div></div>
    <div class="grille2"><label><span class="etiquette">Montant payé</span><span class="avec-unite"><input class="champ grand" id="t-montant" inputmode="decimal" placeholder="0,00"> €</span></label>
      <label><span class="etiquette">Litres de gazole</span><span class="avec-unite"><input class="champ" id="t-litres" inputmode="decimal"> L</span></label>
      <label><span class="etiquette">Jour du plein</span><input class="champ" type="date" id="t-jour" value="${aujourdhui()}" max="${aujourdhui()}"></label>
      <label><span class="etiquette">Compteur (facultatif)</span><span class="avec-unite"><input class="champ" id="t-km" inputmode="numeric"> km</span></label></div>
    <span class="etiquette">Payé avec</span><div class="trois">${[['cb', 'Carte bancaire G2T'], ['carte', 'Carte carburant'], ['autre', 'Autre / espèces']].map(([v, n]) => `<button type="button" class="choix" data-p="${v}">${n}</button>`).join('')}</div>
    <p class="alerte mal" id="t-erreur" hidden></p><button type="button" class="btn plein grand" id="t-envoyer">➤ Envoyer au bureau</button></div>`
  let paiement = null
  document.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { paiement = b.dataset.p; document.querySelectorAll('[data-p]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))) }))
  $('#t-envoyer').addEventListener('click', () => {
    const montant = nombre($('#t-montant').value), err = $('#t-erreur')
    err.hidden = true
    if (montant === null || !(montant > 0)) { err.textContent = 'Indiquez le montant total payé, en euros (ex. 312,89).'; err.hidden = false; return }
    if (!paiement) { err.textContent = 'Comment avez-vous payé ?'; err.hidden = false; return }
    URL.revokeObjectURL(apercu)
    const suite = paiement === 'cb' ? 'En service, il est joint tout seul au paiement de la banque (même montant, même jour) dès l’import du relevé.'
      : paiement === 'carte' ? 'En service, il sert à contrôler la facture mensuelle de la carte carburant.' : 'En service, le bureau le retrouve dans la liste des tickets.'
    $('#ticket').innerHTML = `<div class="carte centre"><div class="grosse-coche">✓</div><h2>Ticket envoyé au bureau</h2><p class="mut">${suite}</p>
      <p class="note">Démonstration : rien n’a été envoyé ni enregistré.</p><button type="button" class="btn fin" id="t-autre">📷 Envoyer un autre ticket</button></div>`
    $('#t-autre').addEventListener('click', ticketChoix)
  })
}

// ——— Réglages de la démo ———
function afficherReglages() {
  $('#r-carte').innerHTML = Object.entries(CARTES).map(([id, c]) => `<option value="${id}" ${reglages.carte === id ? 'selected' : ''}>${esc(c.nom)}</option>`).join('')
  $('#r-remise').value = String(reglages.remise).replace('.', ',')
  $('#r-reservoir').value = reglages.reservoir
  $('#r-conso').value = String(reglages.conso).replace('.', ',')
  $('#r-pl').checked = reglages.poidsLourds
}
function enregistrerReglages() {
  const r = { carte: $('#r-carte').value, remise: nombre($('#r-remise').value) ?? 0, reservoir: nombre($('#r-reservoir').value), conso: nombre($('#r-conso').value), poidsLourds: $('#r-pl').checked }
  if (!(r.reservoir >= 10 && r.reservoir <= 2000) || !(r.conso >= 1 && r.conso <= 100) || !(r.remise >= 0 && r.remise <= 100)) { $('#r-message').textContent = 'Valeurs illisibles.'; return }
  reglages = r; ecrire('g2t:reglages', r); etat.conseil = null
  $('#r-message').textContent = 'Enregistré.'
  afficherEntete(); afficherResultats()
}

// ——— Installation sur l'écran d'accueil ———
function astuceInstallation() {
  const installee = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  if (installee || lire('g2t:astuce', false)) return
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const z = $('#astuce')
  z.hidden = false
  z.querySelector('.texte').textContent = ios ? 'Touchez le bouton Partager (carré avec une flèche), puis « Sur l’écran d’accueil ».' : 'Ouvrez le menu du navigateur (⋮), puis « Installer l’application » ou « Ajouter à l’écran d’accueil ».'
  z.querySelector('.fermer').addEventListener('click', () => { z.hidden = true; ecrire('g2t:astuce', true) })
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    const b = z.querySelector('.installer')
    b.hidden = false
    b.onclick = async () => { await e.prompt(); z.hidden = true; ecrire('g2t:astuce', true) }
  })
}

// ——— Démarrage ———
document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => { etat.onglet = b.dataset.onglet; afficherEntete() }))
$('#autonomie').addEventListener('input', (e) => { etat.autonomie = e.target.value; etat.conseil = null; afficherResultats() })
$('#autonomie').addEventListener('keydown', (e) => { if (e.key === 'Enter') chercher() })
$('#chercher').addEventListener('click', chercher)
$('#r-enregistrer').addEventListener('click', enregistrerReglages)
afficherReglages(); afficherEntete(); afficherDepart(); afficherDestination(); afficherBouton(); ticketChoix(); astuceInstallation()
localiser()
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})
