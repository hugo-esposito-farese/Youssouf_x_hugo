const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

const EXTRACTION_TOOL = {
  name: 'extraire_compteur',
  description:
    "Enregistre les valeurs lues sur l'écran du compteur du camion visible sur la photo.",
  input_schema: {
    type: 'object',
    properties: {
      km: {
        type: ['number', 'null'],
        description:
          "Kilométrage total affiché à l'écran. L'écran affiche généralement une décimale (ex. 502225.6) : la conserver telle quelle, ne pas arrondir. null si illisible ou incertain.",
      },
      heure: {
        type: ['string', 'null'],
        description:
          "Heure affichée à l'écran du compteur, au format HH:MM (24h). null si illisible ou incertain.",
      },
      jauge: {
        type: ['integer', 'null'],
        description:
          "Niveau de carburant en pourcentage (0 à 100), estimé en comptant les segments allumés de la barre de GAUCHE UNIQUEMENT " +
          "(l'icône de droite est la batterie, à ignorer totalement même si elle est allumée en rouge — batterie faible ne veut pas dire carburant faible). " +
          "Certains écrans de compteur (boîtier secondaire sans jauge visible) n'affichent aucune barre de carburant : dans ce cas renvoyer null, c'est normal, pas une erreur. " +
          "Renvoyer aussi null si la barre est présente mais illisible avec certitude.",
      },
    },
    required: ['km', 'heure', 'jauge'],
  },
};

const SYSTEM_PROMPT = `Tu lis l'écran du compteur d'un camion sur une photo prise par un chauffeur.
Extrait uniquement trois informations : le kilométrage total, l'heure affichée à l'écran, et le niveau de la jauge de carburant.

Le chauffeur peut photographier deux écrans différents du même camion :
- Le combiné d'instruments principal (écran couleur) : affiche le km avec une décimale, l'heure, et deux barres de jauge segmentées côte à côte (carburant à gauche, batterie à droite).
- Un boîtier secondaire monochrome (marque "Renault Trucks", avec boutons OK/haut/bas) : affiche le km et l'heure, mais AUCUNE jauge de carburant. Sur cet écran, jauge doit valoir null — ce n'est pas une erreur, la donnée n'existe simplement pas sur cette photo.

Règles importantes :
- S'il y a deux icônes de type "jauge" côte à côte, celle de GAUCHE est le carburant (à lire), celle de DROITE est la batterie (à ignorer complètement, ne jamais la confondre avec le carburant, même si elle est allumée en rouge).
- L'heure à utiliser est celle affichée à l'écran du camion, jamais une heure déduite autrement.
- Si une valeur n'est pas lisible avec certitude sur la photo, renvoie null pour cette valeur plutôt que d'inventer ou d'estimer. Il vaut mieux une case vide qu'une valeur fausse.
- Réponds uniquement en appelant l'outil fourni, avec les valeurs lues.`;

/**
 * @param {Buffer} imageBuffer
 * @param {string} mimeType ex. "image/jpeg"
 * @returns {Promise<{km: number|null, heure: string|null, jauge: string|null}>}
 */
async function extraireDonneesCompteur(imageBuffer, mimeType) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: 'extraire_compteur' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: imageBuffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: 'Lis le kilométrage, l\'heure et la jauge de carburant (icône de gauche uniquement) sur cette photo.',
          },
        ],
      },
    ],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse) {
    throw new Error("Claude n'a pas renvoyé de résultat structuré pour cette photo.");
  }

  const { km, heure, jauge } = toolUse.input;
  const jaugeValide = typeof jauge === 'number' && Number.isFinite(jauge) && jauge >= 0 && jauge <= 100;
  return {
    km: typeof km === 'number' ? km : null,
    heure: typeof heure === 'string' ? heure : null,
    jauge: jaugeValide ? Math.round(jauge) : null,
  };
}

module.exports = { extraireDonneesCompteur };
