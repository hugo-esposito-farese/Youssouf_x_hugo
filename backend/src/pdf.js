const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Voir docs/photos-et-sorties.md pour le détail des 2 feuilles reproduites ici.

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
const JOURS_ABBR_FR = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function pdfFileName(year, month) {
  return `feuille-vehicule-${monthKey(year, month)}.pdf`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildDateList(year, month) {
  const total = daysInMonth(year, month);
  const dates = [];
  for (let d = 1; d <= total; d += 1) {
    dates.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return dates;
}

function dateLabelShort(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

function dateLabelActivite(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${JOURS_ABBR_FR[dow]}. ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

function fmtKm(value) {
  return value === null || value === undefined ? '' : Number(value).toFixed(1);
}

function fmt(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

// Un jour "clos" pour la feuille véhicule = un event 'debut' ET un event 'fin' ce jour-là
// (cf. CLAUDE_youssouf.md). On prend le PREMIER 'debut' et le DERNIER 'fin' chronologiques du
// jour (une journée peut avoir plusieurs shifts, cf. docs/photos-et-sorties.md).
async function getDonneesVehiculeParJour(pool, year, month) {
  const debut = new Date(Date.UTC(year, month - 1, 1));
  const fin = new Date(Date.UTC(year, month, 1));
  const { rows } = await pool.query(
    `
    WITH first_debut AS (
      SELECT DISTINCT ON (event_date)
        event_date, km AS km_depart, jauge AS jauge_depart, conducteur
      FROM events
      WHERE type = 'debut' AND event_date >= $1 AND event_date < $2
      ORDER BY event_date, heure NULLS LAST, created_at
    ),
    last_fin AS (
      SELECT DISTINCT ON (event_date)
        event_date, km AS km_arrivee, jauge AS jauge_arrivee
      FROM events
      WHERE type = 'fin' AND event_date >= $1 AND event_date < $2
      ORDER BY event_date, heure DESC NULLS LAST, created_at DESC
    )
    SELECT fd.event_date, fd.km_depart, lf.km_arrivee, fd.jauge_depart, lf.jauge_arrivee, fd.conducteur
    FROM first_debut fd
    JOIN last_fin lf ON lf.event_date = fd.event_date;
    `,
    [debut, fin],
  );
  const map = new Map();
  for (const row of rows) map.set(row.event_date, row);
  return map;
}

// Corrections manuelles / réponses du workflow post-photo, une ligne par jour ayant au moins
// une valeur renseignée. Voir day_overrides dans db.js.
async function getOverridesParJour(pool, year, month) {
  const debut = new Date(Date.UTC(year, month - 1, 1));
  const fin = new Date(Date.UTC(year, month, 1));
  const { rows } = await pool.query(
    `SELECT event_date, km_depart, km_arrivee, jauge_depart, jauge_arrivee, conducteur,
            petit_dejeuner, repas_midi, repas_soir, decouche_inter, decouche_natio
     FROM day_overrides
     WHERE event_date >= $1 AND event_date < $2`,
    [debut, fin],
  );
  const map = new Map();
  for (const row of rows) map.set(row.event_date, row);
  return map;
}

// Fusionne la donnée dérivée des events (base IA) avec une éventuelle correction manuelle :
// l'override prime uniquement s'il est non-NULL, sinon la donnée IA reste affichée.
function mergeJourVehicule(base, override) {
  const b = base || {};
  const o = override || {};
  return {
    km_depart: o.km_depart ?? b.km_depart ?? null,
    km_arrivee: o.km_arrivee ?? b.km_arrivee ?? null,
    jauge_depart: o.jauge_depart ?? b.jauge_depart ?? null,
    jauge_arrivee: o.jauge_arrivee ?? b.jauge_arrivee ?? null,
    conducteur: o.conducteur ?? b.conducteur ?? null,
  };
}

// Les 5 champs activité n'ont pas d'équivalent IA : day_overrides est leur seule source,
// false par défaut (y compris pour les mois/jours déjà existants avant cette fonctionnalité).
function mergeJourActivite(override) {
  return {
    petit_dejeuner: Boolean(override && override.petit_dejeuner),
    repas_midi: Boolean(override && override.repas_midi),
    repas_soir: Boolean(override && override.repas_soir),
    decouche_inter: Boolean(override && override.decouche_inter),
    decouche_natio: Boolean(override && override.decouche_natio),
  };
}

// Feuille activité : TOUS les events du mois (pas seulement les jours clos), placés dans la
// tranche horaire (0h-8h / 8h-16h / 16h-24h) correspondant à l'heure lue sur la photo.
async function getEvenementsActiviteParJour(pool, year, month) {
  const debut = new Date(Date.UTC(year, month - 1, 1));
  const fin = new Date(Date.UTC(year, month, 1));
  const { rows } = await pool.query(
    `SELECT event_date, type, heure, created_at
     FROM events
     WHERE event_date >= $1 AND event_date < $2
     ORDER BY event_date, heure NULLS LAST, created_at`,
    [debut, fin],
  );
  const map = new Map();
  for (const row of rows) {
    const heureAffichee = row.heure || null;
    let heureNum;
    if (heureAffichee && /^\d{1,2}:\d{2}/.test(heureAffichee)) {
      heureNum = parseInt(heureAffichee.slice(0, 2), 10);
    } else {
      // Repli si l'heure n'a pas pu être lue sur la photo : heure d'upload côté serveur.
      heureNum = new Date(row.created_at).getHours();
    }
    const bande = heureNum < 8 ? 'bande0' : heureNum < 16 ? 'bande1' : 'bande2';
    const label = `${row.type === 'debut' ? 'Début' : 'Fin'} ${heureAffichee || '?'}`;
    if (!map.has(row.event_date)) {
      map.set(row.event_date, { bande0: [], bande1: [], bande2: [] });
    }
    map.get(row.event_date)[bande].push(label);
  }
  return map;
}

function drawCheckbox(doc, x, y, size, checked) {
  doc.lineWidth(0.75).strokeColor('#333333');
  doc.rect(x, y, size, size).stroke();
  if (checked) {
    doc.lineWidth(1.2).strokeColor('#111111');
    doc.moveTo(x + 1.5, y + 1.5).lineTo(x + size - 1.5, y + size - 1.5).stroke();
    doc.moveTo(x + size - 1.5, y + 1.5).lineTo(x + 1.5, y + size - 1.5).stroke();
  }
  doc.strokeColor('#000000');
}

function drawGauge(doc, x, y, width, value) {
  const lineY = y + 6;
  doc.lineWidth(0.75).strokeColor('#999999');
  doc.moveTo(x, lineY).lineTo(x + width, lineY).stroke();
  [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
    const tx = x + width * f;
    doc.moveTo(tx, lineY - 2).lineTo(tx, lineY + 2).stroke();
  });
  if (typeof value === 'number') {
    const mx = x + (width * Math.min(Math.max(value, 0), 100)) / 100;
    doc.lineWidth(1.5).strokeColor('#111111');
    doc.moveTo(mx, lineY - 5).lineTo(mx, lineY + 1).stroke();
    doc.font('Helvetica').fontSize(6).fillColor('#111111')
      .text(`${value}%`, x, lineY + 3, { width, align: 'center' });
  }
  doc.strokeColor('#000000').fillColor('#000000');
}

// pageOptions doit reproduire l'orientation de la page courante (size/layout/margin) : un
// doc.addPage() sans argument revient toujours au format par défaut du document (A4 portrait),
// ce qui cassait l'orientation paysage de la feuille activité dès qu'elle dépassait une page
// (bug constaté en prod : page 2 paysage correcte, page 3 de continuation repassait en portrait
// avec les colonnes Découche/Repas tronquées).
function pageBreakIfNeeded(doc, y, rowHeight, redrawHeader, pageOptions) {
  if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage(pageOptions);
    return redrawHeader();
  }
  return y;
}

function drawHeaderRow(doc, y, headers, colWidths, startX, tableWidth, rowHeight) {
  doc.rect(startX, y, tableWidth, rowHeight).fill('#eeeeee');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000');
  let x = startX;
  headers.forEach((text, i) => {
    doc.text(text, x + 3, y + rowHeight / 2 - 4, { width: colWidths[i] - 6 });
    x += colWidths[i];
  });
  return y + rowHeight;
}

function drawFeuilleVehicule(doc, { dates, donneesParJour, driverName, truckPlate, year, month }) {
  doc.font('Helvetica-Bold').fontSize(16)
    .text(`Feuille véhicule — ${MOIS_FR[month - 1]} ${year}`, { align: 'center' });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#555555')
    .text(`Immatriculation : ${truckPlate}  —  Conducteur : ${driverName}`, { align: 'center' });
  doc.fillColor('#000000');
  doc.moveDown(0.6);

  const startX = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = [
    tableWidth * 0.11, // Date
    tableWidth * 0.13, // km départ
    tableWidth * 0.13, // km arrivée
    tableWidth * 0.18, // jauge départ
    tableWidth * 0.18, // jauge arrivée
    tableWidth * 0.13, // litrage pris
    tableWidth * 0.14, // conducteur
  ];
  const headers = ['Date', 'Km départ', 'Km arrivée', 'Jauge départ', 'Jauge arrivée', 'Litrage pris', 'Conducteur'];
  const headerRowHeight = 16;
  const rowHeight = 19;

  const redrawHeader = () => drawHeaderRow(doc, doc.page.margins.top, headers, colWidths, startX, tableWidth, headerRowHeight);

  let y = drawHeaderRow(doc, doc.y, headers, colWidths, startX, tableWidth, headerRowHeight);

  for (const dateStr of dates) {
    y = pageBreakIfNeeded(doc, y, rowHeight, redrawHeader, { size: 'A4', margin: 30 });

    const jour = donneesParJour.get(dateStr);
    let x = startX;

    doc.font('Helvetica').fontSize(9).fillColor('#000000');
    doc.text(dateLabelShort(dateStr), x + 3, y + rowHeight / 2 - 4, { width: colWidths[0] - 6 });
    x += colWidths[0];

    doc.text(jour ? fmtKm(jour.km_depart) : '', x + 3, y + rowHeight / 2 - 4, { width: colWidths[1] - 6 });
    x += colWidths[1];
    doc.text(jour ? fmtKm(jour.km_arrivee) : '', x + 3, y + rowHeight / 2 - 4, { width: colWidths[2] - 6 });
    x += colWidths[2];

    drawGauge(doc, x + 4, y + 1, colWidths[3] - 8, jour ? jour.jauge_depart : null);
    x += colWidths[3];
    drawGauge(doc, x + 4, y + 1, colWidths[4] - 8, jour ? jour.jauge_arrivee : null);
    x += colWidths[4];

    // Litrage pris : jamais disponible depuis la photo du compteur, colonne volontairement vide.
    x += colWidths[5];

    doc.font('Helvetica').fontSize(9);
    doc.text(jour ? fmt(jour.conducteur) : '', x + 3, y + rowHeight / 2 - 4, { width: colWidths[6] - 6 });

    y += rowHeight;
    doc.moveTo(startX, y).lineTo(startX + tableWidth, y).strokeColor('#dddddd').stroke();
    doc.strokeColor('#000000');
  }
}

// Index des colonnes "case à cocher" dans colWidths/headers ci-dessous, et champ booléen
// correspondant dans la donnée activité fusionnée (mergeJourActivite).
const COLONNES_CASES = [
  { champ: 'petit_dejeuner', index: 5 },
  { champ: 'repas_midi', index: 6 },
  { champ: 'repas_soir', index: 7 },
  { champ: 'decouche_inter', index: 8 },
  { champ: 'decouche_natio', index: 9 },
];

function drawFeuilleActivite(doc, { dates, evenementsParJour, activiteParJour, year, month }) {
  doc.font('Helvetica-Bold').fontSize(16)
    .text(`Feuille activité — ${MOIS_FR[month - 1]} ${year}`, { align: 'center' });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(9).fillColor('#555555')
    .text('Destination : non renseignée (hors périmètre).', { align: 'center' });
  doc.fillColor('#000000');
  doc.moveDown(0.6);

  const startX = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = [
    tableWidth * 0.09, // Date
    tableWidth * 0.14, // 0h-8h
    tableWidth * 0.14, // 8h-16h
    tableWidth * 0.14, // 16h-24h
    tableWidth * 0.11, // destination
    tableWidth * 0.08, // petit déjeuner
    tableWidth * 0.08, // repas midi
    tableWidth * 0.08, // repas soir
    tableWidth * 0.07, // découche inter
    tableWidth * 0.07, // découche natio
  ];
  const headerRowHeight = 28;
  const subHeaderHeight = 14;
  const lineHeight = 10;
  const minRowHeight = 20;

  function drawHeader(y) {
    doc.rect(startX, y, tableWidth, headerRowHeight).fill('#eeeeee');
    doc.strokeColor('#bbbbbb').lineWidth(0.5);
    doc.moveTo(startX, y + subHeaderHeight).lineTo(startX + tableWidth, y + subHeaderHeight).stroke();

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000');
    let x = startX;
    const simples = ['Date', 'de 0h à 8h', 'de 8h à 16h', 'de 16h à 24h', 'Destination'];
    simples.forEach((text, i) => {
      doc.text(text, x + 3, y + headerRowHeight / 2 - 4, { width: colWidths[i] - 6 });
      x += colWidths[i];
    });

    // Groupe "Repas" : 3 sous-colonnes (petit déjeuner / midi / soir).
    const repasX = x;
    const repasWidth = colWidths[5] + colWidths[6] + colWidths[7];
    doc.text('Repas', repasX, y + 3, { width: repasWidth, align: 'center' });
    ['P. déj.', 'Midi', 'Soir'].forEach((text, i) => {
      doc.fontSize(7).text(text, x + 2, y + subHeaderHeight + 3, { width: colWidths[5 + i] - 4, align: 'center' });
      doc.fontSize(8);
      x += colWidths[5 + i];
    });

    // Groupe "Découche" : 2 sous-colonnes (inter / natio).
    const decoucheX = x;
    const decoucheWidth = colWidths[8] + colWidths[9];
    doc.text('Découche', decoucheX, y + 3, { width: decoucheWidth, align: 'center' });
    ['Inter', 'Natio'].forEach((text, i) => {
      doc.fontSize(7).text(text, x + 2, y + subHeaderHeight + 3, { width: colWidths[8 + i] - 4, align: 'center' });
      doc.fontSize(8);
      x += colWidths[8 + i];
    });

    return y + headerRowHeight;
  }

  const redrawHeader = () => drawHeader(doc.page.margins.top);

  let y = drawHeader(doc.y);

  for (const dateStr of dates) {
    const evt = evenementsParJour.get(dateStr) || { bande0: [], bande1: [], bande2: [] };
    const act = activiteParJour.get(dateStr) || mergeJourActivite(null);
    const maxLignes = Math.max(1, evt.bande0.length, evt.bande1.length, evt.bande2.length);
    const rowHeight = Math.max(minRowHeight, 8 + maxLignes * lineHeight);

    y = pageBreakIfNeeded(doc, y, rowHeight, redrawHeader, { size: 'A4', layout: 'landscape', margin: 30 });

    let x = startX;
    doc.font('Helvetica').fontSize(8).fillColor('#000000');
    doc.text(dateLabelActivite(dateStr), x + 3, y + 6, { width: colWidths[0] - 6 });
    x += colWidths[0];

    [evt.bande0, evt.bande1, evt.bande2].forEach((lignes) => {
      doc.text(lignes.join('\n'), x + 3, y + 6, { width: colWidths[1] - 6 });
      x += colWidths[1];
    });

    // destination : hors périmètre, volontairement vide.
    x += colWidths[4];

    const boxSize = 8;
    COLONNES_CASES.forEach(({ champ, index }) => {
      const cx = x + colWidths[index] / 2 - boxSize / 2;
      const cy = y + rowHeight / 2 - boxSize / 2;
      drawCheckbox(doc, cx, cy, boxSize, Boolean(act[champ]));
      x += colWidths[index];
    });

    y += rowHeight;
    doc.moveTo(startX, y).lineTo(startX + tableWidth, y).strokeColor('#dddddd').stroke();
    doc.strokeColor('#000000');
  }
}

async function regenerateMonthPdf({ pool, storageDir, year, month, driverName, truckPlate }) {
  const dates = buildDateList(year, month);
  const [donneesParJour, evenementsParJour, overridesParJour] = await Promise.all([
    getDonneesVehiculeParJour(pool, year, month),
    getEvenementsActiviteParJour(pool, year, month),
    getOverridesParJour(pool, year, month),
  ]);

  const donneesFusionnees = new Map();
  for (const dateStr of dates) {
    const merged = mergeJourVehicule(donneesParJour.get(dateStr), overridesParJour.get(dateStr));
    if (merged.km_depart !== null || merged.km_arrivee !== null) donneesFusionnees.set(dateStr, merged);
  }
  const activiteParJour = new Map();
  for (const dateStr of dates) {
    activiteParJour.set(dateStr, mergeJourActivite(overridesParJour.get(dateStr)));
  }

  fs.mkdirSync(storageDir, { recursive: true });
  const filePath = path.join(storageDir, pdfFileName(year, month));

  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  drawFeuilleVehicule(doc, { dates, donneesParJour: donneesFusionnees, driverName, truckPlate, year, month });
  // Feuille activité en paysage (plus de colonnes, template papier existant du chauffeur).
  doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });
  drawFeuilleActivite(doc, { dates, evenementsParJour, activiteParJour, year, month });

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { fileName: pdfFileName(year, month), filePath };
}

module.exports = {
  regenerateMonthPdf,
  pdfFileName,
  monthKey,
  getDonneesVehiculeParJour,
  getEvenementsActiviteParJour,
  getOverridesParJour,
  mergeJourVehicule,
  mergeJourActivite,
  buildDateList,
};
