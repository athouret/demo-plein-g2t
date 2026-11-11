// Règles du choix de la station (reprises telles quelles de l'appli carburant). Aucun appel réseau ici.
// Appli carburant des chauffeurs : où faire le plein de gazole au meilleur prix, sur le trajet à venir.
//
// Les prix viennent du flux officiel « Prix des carburants » (prix-carburants.gouv.fr, mis à jour en continu par les stations),
// l'enseigne de chaque station d'un annuaire communautaire du même flux (le flux officiel ne la donne pas),
// l'itinéraire du service de calcul d'itinéraire de l'IGN (Géoplateforme).
//
// Pour chaque station proche du trajet et atteignable avec l'autonomie restante (moins une réserve de sécurité) :
//   prix payé      = prix à la pompe − remise de la carte du camion
//   litres         = de quoi remplir le réservoir à l'arrivée à la station
//   coût du détour = km de détour × consommation × prix payé  +  minutes de détour × coût horaire du chauffeur
//   prix effectif  = prix payé + coût du détour ÷ litres
// La meilleure station est celle dont le prix effectif est le plus bas. Tout est en euros TTC.
// Ce fichier ne fait aucun appel réseau : il est testé seul (carburant.test.ts).
/** Les enseignes de l'annuaire, pour composer les cartes (nom court → nom affiché). */
export const ENSEIGNES = {
    total: 'TotalEnergies', totalaccess: 'TotalEnergies Access', elan: 'Elan', eni: 'ENI', agip: 'AGIP', esso: 'Esso', essoexpress: 'Esso Express',
    avia: 'Avia', aviaxpress: 'AVIA XPress', shell: 'Shell', bp: 'BP', bpexpress: 'BP Express', dyneff: 'Dyneff', vito: 'VITO', gulf: 'GULF', q8: 'Q8',
    intermarche: 'Intermarché', intercontact: 'Intermarché Contact', systemeu: 'Système U', eleclerc: 'E.Leclerc', carrefour: 'Carrefour',
    carrefourmarket: 'Carrefour Market', carrefourcontact: 'Carrefour Contact', carrefourexpress: 'Carrefour Express', auchan: 'Auchan',
    netto: 'Netto', supermarchematch: 'Supermarché Match', casino: 'Casino', spar: 'Spar', roady: 'Roady', bi1: 'Bi1',
};
export const CARTES_DEFAUT = [
    { id: 'total', nom: 'Carte TotalEnergies', enseignes: ['total', 'totalaccess', 'elan'], toutes: false, remise: 0 },
    { id: 'eni', nom: 'Carte ENI', enseignes: ['eni', 'agip'], toutes: false, remise: 0 },
    { id: 'cb', nom: 'Carte bancaire (toutes stations)', enseignes: [], toutes: true, remise: 0 },
];
export const DEFAUT_VEHICULE = {
    camion: { reservoir: 300, conso: 38, poidsLourds: true },
    voiture: { reservoir: 45, conso: 6, poidsLourds: false },
};
export const REGLAGES_DEFAUT = { cartes: CARTES_DEFAUT, reserveKm: 50, detourMaxKm: 15, coutHeure: 0, vehicules: {} };
const table = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const nombre = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const texte = (v, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
/** Les réglages enregistrés (Paramètres, clé « carburant »), complétés par les valeurs par défaut pour ce qui manque ou est illisible. */
export function lireReglagesCarburant(brut) {
    const r = table(brut);
    const cartes = [];
    if (Array.isArray(r.cartes)) {
        for (const c of r.cartes) {
            const t = table(c), id = texte(t.id, 40), nom = texte(t.nom);
            if (!id || !nom || cartes.some((x) => x.id === id))
                continue;
            const enseignes = Array.isArray(t.enseignes) ? t.enseignes.filter((e) => typeof e === 'string' && /^[a-z0-9]{1,40}$/.test(e)) : [];
            cartes.push({ id, nom, enseignes: [...new Set(enseignes)], toutes: t.toutes === true, remise: nombre(t.remise, 0, 1) ?? 0 });
        }
    }
    const vehicules = {};
    for (const [id, v] of Object.entries(table(r.vehicules))) {
        const t = table(v);
        if (!/^[0-9a-f-]{36}$/.test(id))
            continue;
        vehicules[id] = {
            cartes: Array.isArray(t.cartes) ? t.cartes.filter((c) => typeof c === 'string') : [],
            reservoir: nombre(t.reservoir, 10, 2000) ?? DEFAUT_VEHICULE.camion.reservoir,
            conso: nombre(t.conso, 1, 100) ?? DEFAUT_VEHICULE.camion.conso,
            poidsLourds: t.poidsLourds !== false,
            jeton: typeof t.jeton === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(t.jeton) ? t.jeton : null,
            lienCreeLe: texte(t.lienCreeLe, 40),
        };
    }
    return {
        cartes: Array.isArray(r.cartes) ? cartes : CARTES_DEFAUT,
        reserveKm: nombre(r.reserveKm, 0, 300) ?? REGLAGES_DEFAUT.reserveKm,
        detourMaxKm: nombre(r.detourMaxKm, 1, 100) ?? REGLAGES_DEFAUT.detourMaxKm,
        coutHeure: nombre(r.coutHeure, 0, 500) ?? REGLAGES_DEFAUT.coutHeure,
        vehicules,
    };
}
// ——— Géométrie ———
const R_TERRE = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
/** Distance à vol d'oiseau en km. */
export function distanceKm(a, b) {
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TERRE * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Le tracé allégé (un point tous les « pas » km au plus) et la distance cumulée depuis le départ à chaque point. */
export function allegerTrace(coords, pasKm = 0.2) {
    if (!coords.length)
        return { points: [], cumul: [] };
    const points = [coords[0]], cumul = [0];
    let total = 0, depuis = 0;
    for (let i = 1; i < coords.length; i++) {
        const d = distanceKm(coords[i - 1], coords[i]);
        total += d;
        depuis += d;
        if (depuis >= pasKm || i === coords.length - 1) {
            points.push(coords[i]);
            cumul.push(total);
            depuis = 0;
        }
    }
    return { points, cumul };
}
/**
 * Où tombe une station par rapport au trajet : à combien de km du départ (le long du trajet) se trouve le point du trajet
 * le plus proche, et à quelle distance à vol d'oiseau elle en est (l'écart).
 */
export function projeter(trace, p) {
    const { points, cumul } = trace;
    if (points.length === 1)
        return { kmDepuisDepart: 0, ecartKm: distanceKm(points[0], p) };
    let meilleur = { kmDepuisDepart: 0, ecartKm: Infinity };
    // Projection plane locale (équirectangulaire autour de la station) : précise à quelques mètres sur ces distances.
    const kx = 111.32 * Math.cos(rad(p[1])), ky = 110.57;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(x, y);
        if (d < meilleur.ecartKm)
            meilleur = { kmDepuisDepart: cumul[i - 1] + t * (cumul[i] - cumul[i - 1]), ecartKm: d };
    }
    return meilleur;
}
/** Des points du trajet espacés de « pasKm », jusqu'à « jusquaKm » : les centres des cercles où chercher les stations. */
export function jalons(trace, pasKm, jusquaKm) {
    const out = [];
    let prochain = 0;
    for (let i = 0; i < trace.points.length; i++) {
        if (trace.cumul[i] > jusquaKm + pasKm)
            break;
        if (trace.cumul[i] >= prochain) {
            out.push(trace.points[i]);
            prochain = trace.cumul[i] + pasKm;
        }
    }
    const dernier = trace.points.findLast((_, i) => trace.cumul[i] <= jusquaKm);
    if (dernier && out.at(-1) !== dernier)
        out.push(dernier);
    return out;
}
/** Jour (1 = lundi … 7 = dimanche) et minute de la journée, à l'heure de Paris. */
export function heureDeParis(d) {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
    const jour = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
    return { jour, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
const enMinutes = (h) => {
    const m = /^(\d{1,2})[.:h](\d{2})$/.exec(h ?? '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/**
 * La station est-elle ouverte à ce moment-là ? Vrai si un automate 24 h/24 est déclaré. Null quand on ne sait pas
 * (horaires absents ou incohérents, par exemple tous les jours « fermé ») : la station reste proposée, avec une mention.
 */
export function ouverteA(horairesJson, quand) {
    if (!horairesJson)
        return null;
    let h;
    try {
        h = JSON.parse(horairesJson);
    }
    catch {
        return null;
    }
    if (h['@automate-24-24'] === '1')
        return true;
    const jours = Array.isArray(h.jour) ? h.jour : h.jour ? [h.jour] : [];
    if (!jours.length || jours.every((j) => j['@ferme'] === '1'))
        return null;
    const { jour, minute } = heureDeParis(quand);
    const j = jours.find((x) => Number(x['@id']) === jour);
    if (!j)
        return null;
    if (j['@ferme'] === '1')
        return false;
    const plages = Array.isArray(j.horaire) ? j.horaire : j.horaire ? [j.horaire] : [];
    if (!plages.length)
        return null;
    for (const p of plages) {
        const o = enMinutes(p['@ouverture']), f = enMinutes(p['@fermeture']);
        if (o === null || f === null)
            continue;
        if (f === o)
            continue; // « 01.00 – 01.00 » : plage vide
        const fin = f === 23 * 60 + 59 ? 24 * 60 : f;
        if (fin > o ? minute >= o && minute < fin : minute >= o || minute < fin)
            return true;
    }
    return false;
}
const FACTEUR_ROUTE = 1.35; // la route fait en moyenne 35 % de plus que le vol d'oiseau
const VITESSE_DETOUR = 45; // km/h sur les routes d'un détour
export const PRIX_PERIME_JOURS = 8;
/** La carte du véhicule qui paie le moins cher dans cette station (null : aucune n'y passe, ou enseigne inconnue). */
export function carteAcceptee(cartes, s) {
    let meilleure = null;
    for (const c of cartes) {
        const passe = c.toutes || (s.enseigne ? c.enseignes.includes(s.enseigne) : false);
        if (passe && (!meilleure || c.remise > meilleure.remise))
            meilleure = c;
    }
    return meilleure;
}
/** Le véhicule a-t-il une carte limitée à certaines enseignes (et aucune carte « toutes stations ») ? */
export const carteLimitee = (cartes) => cartes.length > 0 && !cartes.some((c) => c.toutes);
/** Le détour estimé sans itinéraire : aller-retour depuis le trajet, allongé du facteur route. */
export function detourEstime(ecartKm) {
    const km = ecartKm < 0.15 ? 0 : 2 * ecartKm * FACTEUR_ROUTE;
    return { km, min: (km / VITESSE_DETOUR) * 60 };
}
/**
 * Évalue une station : null si elle est hors de portée, trop loin du trajet, en rupture, fermée à l'arrivée,
 * sans piste poids lourds pour un camion qui l'exige, ou si son prix est trop ancien.
 * « detour » remplace l'estimation quand l'itinéraire réel a été calculé.
 */
export function evaluer(s, p, trajet, saisie, detour) {
    if (p.poidsLourds && !s.poidsLourds)
        return null;
    const ageJours = (saisie.maintenant.getTime() - Date.parse(s.maj)) / 86400000;
    if (!(ageJours <= PRIX_PERIME_JOURS))
        return null;
    // Autour de moi, le « trajet » n'a qu'un point : l'écart est la distance à la station, le détour l'aller-retour.
    const proj = projeter(trajet.trace, s.position);
    const kmDepuisDepart = detour?.kmDepuisDepart ?? proj.kmDepuisDepart, ecartKm = proj.ecartKm;
    const vitesse = trajet.minutes > 0 ? trajet.km / (trajet.minutes / 60) : VITESSE_DETOUR;
    const d = detour ?? detourEstime(ecartKm);
    if (d.km > p.detourMaxKm + 0.01)
        return null;
    const kmJusqua = kmDepuisDepart + d.km / 2;
    if (kmJusqua > saisie.autonomieKm - p.reserveKm)
        return null;
    const arrivee = new Date(saisie.maintenant.getTime() + ((kmDepuisDepart / vitesse) * 60 + d.min / 2) * 60000);
    const ouverte = ouverteA(s.horaires, arrivee);
    if (ouverte === false && !s.automate)
        return null;
    const carte = carteAcceptee(p.cartes, s);
    const prixPaye = Math.max(0, s.prix - (carte?.remise ?? 0));
    const resteAvant = Math.max(0, ((saisie.autonomieKm - kmJusqua) * p.conso) / 100);
    const litres = Math.max(1, Math.min(p.reservoir, p.reservoir - resteAvant));
    const coutDetour = ((d.km * p.conso) / 100) * prixPaye + (d.min / 60) * p.coutHeure;
    return {
        station: s, kmDepuisDepart, ecartKm, detourKm: d.km, detourMin: d.min, detourCalcule: Boolean(detour), carte, prixPaye,
        litres, coutDetour, prixEffectif: prixPaye + coutDetour / litres, arrivee, ouverte: ouverte ?? (s.automate ? true : null),
        prixAncien: ageJours > 2,
    };
}
/** Autour de moi : la position de départ sert de « trajet » d'un seul point. */
export const trajetPonctuel = (depart) => ({ trace: { points: [depart], cumul: [0] }, km: 0, minutes: 0 });
/** Classement : prix effectif croissant, puis la station la plus proche. */
export const classer = (a, b) => a.prixEffectif - b.prixEffectif || a.kmDepuisDepart - b.kmDepuisDepart;
/** Prix payé moyen des stations retenues (pour chiffrer l'économie) : ce qu'on paierait en s'arrêtant au hasard sur le trajet. */
export function prixMoyen(candidats) {
    const avec = candidats.filter((c) => c.carte);
    return avec.length ? avec.reduce((s, c) => s + c.prixPaye, 0) / avec.length : null;
}
