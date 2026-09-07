(() => {
  const API_BASE_URL = (window.API_BASE_URL || '').replace(/\/$/, '');
  const TOKEN_KEY = 'feuille_auth_token';

  const loginScreen = document.getElementById('login-screen');
  const loginForm = document.getElementById('login-form');
  const loginUsername = document.getElementById('login-username');
  const loginPassword = document.getElementById('login-password');
  const loginError = document.getElementById('login-error');
  const appContent = document.getElementById('app-content');
  const btnLogout = document.getElementById('btn-logout');

  const btnDebut = document.getElementById('btn-debut');
  const btnFin = document.getElementById('btn-fin');
  const photoInput = document.getElementById('photo-input');
  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('result');
  const pdfLinkWrap = document.getElementById('pdf-link-wrap');
  const pdfLink = document.getElementById('pdf-link');
  const questionsEl = document.getElementById('questions');
  const btnEditToggle = document.getElementById('btn-edit-toggle');
  const feuilleSection = document.getElementById('feuille-section');
  const tableVehicule = document.getElementById('table-vehicule');
  const tableActivite = document.getElementById('table-activite');

  let pendingType = null;
  let authToken = localStorage.getItem(TOKEN_KEY);

  // --- Authentification : personne sans session valide ne peut lire ni modifier la feuille ---

  function showApp() {
    loginScreen.hidden = true;
    appContent.hidden = false;
  }

  function showLogin() {
    appContent.hidden = true;
    loginScreen.hidden = false;
  }

  // Efface tout l'état visuel propre à une session (lien PDF, feuilles éditables, résultat de
  // la dernière photo, questions en cours...). Indispensable à la fois à la déconnexion et juste
  // avant d'afficher l'app après une connexion : sans ça, changer de compte sur le même appareil
  // sans recharger la page laissait le lien PDF (et son token) du compte précédent visible et
  // cliquable — un compte pouvait ainsi ouvrir la feuille d'un autre.
  function resetAppState() {
    pendingType = null;
    statusEl.textContent = '';
    statusEl.classList.remove('error');
    resultEl.hidden = true;
    pdfLinkWrap.hidden = true;
    pdfLink.href = '#';
    questionsEl.hidden = true;
    questionsEl.innerHTML = '';
    feuilleSection.hidden = true;
    btnEditToggle.textContent = '✏️ Modifier manuellement la feuille';
    tableVehicule.innerHTML = '';
    tableActivite.innerHTML = '';
  }

  function logout() {
    authToken = null;
    localStorage.removeItem(TOKEN_KEY);
    resetAppState();
    showLogin();
  }

  // Ajoute automatiquement l'en-tête Authorization et déconnecte proprement sur une session
  // expirée/invalide (401) plutôt que de laisser l'appelant gérer ce cas partout.
  function authFetch(url, options = {}) {
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${authToken}` };
    return fetch(url, { ...options, headers }).then((res) => {
      if (res.status === 401) {
        logout();
        throw new Error('Session expirée, reconnecte-toi.');
      }
      return res;
    });
  }

  // Pour les liens <a> (PDF ouvert dans un nouvel onglet) : pas d'en-tête possible, le token
  // voyage donc en query string (accepté par le backend pour la route /files uniquement).
  function withToken(url) {
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(authToken)}`;
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    try {
      const res = await fetch(`${API_BASE_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername.value, password: loginPassword.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        loginError.textContent = data.error || 'Identifiants invalides.';
        return;
      }
      authToken = data.token;
      localStorage.setItem(TOKEN_KEY, authToken);
      loginPassword.value = '';
      resetAppState();
      showApp();
      checkExistingPdf();
    } catch (err) {
      loginError.textContent = "Erreur de connexion au serveur.";
    }
  });

  btnLogout.addEventListener('click', logout);

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  function setButtonsDisabled(disabled) {
    btnDebut.disabled = disabled;
    btnFin.disabled = disabled;
  }

  function requestPhoto(type) {
    if (!API_BASE_URL) {
      setStatus("Configuration manquante : renseigne l'URL du backend dans config.js.", true);
      return;
    }
    pendingType = type;
    photoInput.value = '';
    photoInput.click();
  }

  btnDebut.addEventListener('click', () => requestPhoto('debut'));
  btnFin.addEventListener('click', () => requestPhoto('fin'));

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files && photoInput.files[0];
    if (!file || !pendingType) return;

    const type = pendingType;
    pendingType = null;
    resultEl.hidden = true;
    setButtonsDisabled(true);
    setStatus('Analyse de la photo en cours…');

    try {
      const formData = new FormData();
      formData.append('type', type);
      formData.append('photo', file);

      const response = await authFetch(`${API_BASE_URL}/api/events`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Erreur serveur (${response.status})`);
      }

      const data = await response.json();
      showResult(type, data);
      setStatus('Photo enregistrée.');
      fetchAndRenderMonth();

      if (type === 'fin') {
        startQuestionsFlow(data.event.event_date);
      }
    } catch (err) {
      console.error(err);
      setStatus(err.message || "Erreur lors de l'envoi de la photo.", true);
    } finally {
      setButtonsDisabled(false);
    }
  });

  function showResult(type, data) {
    document.getElementById('res-type').textContent = type === 'debut' ? 'Début' : 'Fin';
    document.getElementById('res-km').textContent = data.event.km ?? 'à vérifier';
    document.getElementById('res-heure').textContent = data.event.heure ?? 'à vérifier';
    document.getElementById('res-jauge').textContent =
      data.event.jauge === null || data.event.jauge === undefined ? 'à vérifier' : `${data.event.jauge}%`;
    resultEl.hidden = false;

    if (data.pdfUrl) {
      pdfLink.href = withToken(`${API_BASE_URL}${data.pdfUrl}`);
      pdfLinkWrap.hidden = false;
    }
  }

  async function checkExistingPdf() {
    if (!API_BASE_URL || !authToken) return;
    try {
      const res = await authFetch(`${API_BASE_URL}/api/pdf/current-url`);
      if (!res.ok) return;
      const { pdfUrl } = await res.json();
      const head = await authFetch(`${API_BASE_URL}${pdfUrl}`, { method: 'HEAD' });
      if (head.ok) {
        pdfLink.href = withToken(`${API_BASE_URL}${pdfUrl}`);
        pdfLinkWrap.hidden = false;
      }
    } catch (err) {
      // Pas grave si ça échoue au chargement : le lien réapparaîtra après le prochain jour clos.
    }
  }

  // --- Questions post-photo (repas / découché), après un event 'fin' ---

  function patchDay(eventDate, fields) {
    return authFetch(`${API_BASE_URL}/api/days/${eventDate}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Erreur serveur'))))
      .then((data) => {
        if (data.pdfUrl) {
          pdfLink.href = withToken(`${API_BASE_URL}${data.pdfUrl}`);
          pdfLinkWrap.hidden = false;
        }
        fetchAndRenderMonth();
        return data;
      })
      .catch(() => {
        // Pas grave si l'enregistrement d'une réponse échoue : la feuille reste éditable
        // manuellement ensuite (Partie 1), pas besoin de bloquer le workflow photo pour ça.
      });
  }

  // Corrige l'heure lue par l'IA sur un event précis (Début/Fin de la feuille activité).
  // Contrairement à patchDay, ceci modifie l'event source, pas une correction dérivée : l'event
  // peut donc changer de tranche horaire (0h-8h/8h-16h/16h-24h), d'où le fetchAndRenderMonth().
  function patchEvent(id, heure) {
    return authFetch(`${API_BASE_URL}/api/events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ heure }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Erreur serveur'))))
      .then((data) => {
        if (data.pdfUrl) {
          pdfLink.href = withToken(`${API_BASE_URL}${data.pdfUrl}`);
          pdfLinkWrap.hidden = false;
        }
        fetchAndRenderMonth();
        return data;
      })
      .catch(() => {
        // Idem patchDay : échec silencieux, l'utilisateur peut retenter l'édition.
      });
  }

  function endQuestionsFlow() {
    questionsEl.hidden = true;
    questionsEl.innerHTML = '';
  }

  function renderChoiceStep(question, choices) {
    questionsEl.innerHTML = '';
    questionsEl.hidden = false;

    const p = document.createElement('p');
    p.textContent = question;
    questionsEl.appendChild(p);

    const row = document.createElement('div');
    row.className = 'choice-row';
    choices.forEach(({ label, onClick, primary }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = primary ? 'choice-btn primary' : 'choice-btn';
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      row.appendChild(btn);
    });
    questionsEl.appendChild(row);
  }

  function renderRepasChoicesStep(eventDate) {
    questionsEl.innerHTML = '';
    questionsEl.hidden = false;

    const p = document.createElement('p');
    p.textContent = 'Quel(s) repas avez-vous pris ?';
    questionsEl.appendChild(p);

    const list = document.createElement('div');
    list.className = 'checkbox-list';
    const options = [
      { field: 'petit_dejeuner', label: 'Petit déjeuner' },
      { field: 'repas_midi', label: 'Repas midi' },
      { field: 'repas_soir', label: 'Repas soir' },
    ];
    const inputs = {};
    options.forEach(({ field, label }) => {
      const lbl = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      inputs[field] = input;
      lbl.appendChild(input);
      lbl.appendChild(document.createTextNode(label));
      list.appendChild(lbl);
    });
    questionsEl.appendChild(list);

    const row = document.createElement('div');
    row.className = 'choice-row';
    const valider = document.createElement('button');
    valider.type = 'button';
    valider.className = 'choice-btn primary';
    valider.textContent = 'Valider';
    valider.addEventListener('click', async () => {
      await patchDay(eventDate, {
        petit_dejeuner: inputs.petit_dejeuner.checked,
        repas_midi: inputs.repas_midi.checked,
        repas_soir: inputs.repas_soir.checked,
      });
      renderDecoucheStep(eventDate);
    });
    row.appendChild(valider);
    questionsEl.appendChild(row);
  }

  function renderDecoucheStep(eventDate) {
    renderChoiceStep('Allez-vous découcher ce soir ?', [
      {
        label: 'Non',
        onClick: async () => {
          await patchDay(eventDate, { decouche_inter: false, decouche_natio: false });
          endQuestionsFlow();
        },
      },
      {
        label: 'Oui',
        primary: true,
        onClick: () => renderDecoucheChoiceStep(eventDate),
      },
    ]);
  }

  function renderDecoucheChoiceStep(eventDate) {
    renderChoiceStep('En nationale ou internationale ?', [
      {
        label: 'Nationale',
        primary: true,
        onClick: async () => {
          await patchDay(eventDate, { decouche_inter: false, decouche_natio: true });
          endQuestionsFlow();
        },
      },
      {
        label: 'Internationale',
        onClick: async () => {
          await patchDay(eventDate, { decouche_inter: true, decouche_natio: false });
          endQuestionsFlow();
        },
      },
    ]);
  }

  function startQuestionsFlow(eventDate) {
    renderChoiceStep('Avez-vous pris un repas ?', [
      {
        label: 'Non',
        onClick: async () => {
          await patchDay(eventDate, { petit_dejeuner: false, repas_midi: false, repas_soir: false });
          renderDecoucheStep(eventDate);
        },
      },
      {
        label: 'Oui',
        primary: true,
        onClick: () => renderRepasChoicesStep(eventDate),
      },
    ]);
  }

  // --- Feuille véhicule / activité éditables (Partie 1) ---

  function formatDate(dateStr) {
    const [, m, d] = dateStr.split('-');
    return `${d}/${m}`;
  }

  function makeEditableCell(date, field, rawValue, { format, parse }) {
    const td = document.createElement('td');
    td.className = 'editable';
    td.textContent = format(rawValue);

    td.addEventListener('click', () => {
      if (td.querySelector('input')) return;
      const currentText = td.textContent;
      td.textContent = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentText;
      td.appendChild(input);
      input.focus();
      input.select();

      let done = false;
      const commit = async () => {
        if (done) return;
        done = true;
        const value = parse(input.value);
        td.textContent = format(value);
        const updated = await patchDay(date, { [field]: value });
        if (updated && updated.day && updated.day.vehicule) {
          td.textContent = format(updated.day.vehicule[field]);
        }
      };
      const cancel = () => {
        if (done) return;
        done = true;
        td.textContent = currentText;
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          input.removeEventListener('blur', commit);
          cancel();
        }
      });
    });

    return td;
  }

  function parseHeureInput(s) {
    const t = s.trim();
    const m = t.match(/^([0-9]{1,2}):([0-9]{2})$/);
    if (!m) return null;
    const hh = String(Math.min(23, parseInt(m[1], 10))).padStart(2, '0');
    const mm = String(Math.min(59, parseInt(m[2], 10))).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function makeEvenementLine(evenement) {
    const line = document.createElement('div');
    line.className = 'event-line';

    const label = document.createElement('span');
    label.className = 'event-type';
    label.textContent = evenement.type === 'debut' ? 'Début' : 'Fin';
    line.appendChild(label);

    const heureSpan = document.createElement('span');
    heureSpan.className = 'event-heure';
    heureSpan.textContent = evenement.heure || '?';
    line.appendChild(heureSpan);

    heureSpan.addEventListener('click', () => {
      if (heureSpan.querySelector('input')) return;
      const currentText = heureSpan.textContent;
      heureSpan.textContent = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.placeholder = 'HH:MM';
      input.value = currentText === '?' ? '' : currentText;
      heureSpan.appendChild(input);
      input.focus();
      input.select();

      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const parsed = parseHeureInput(input.value);
        if (!parsed) {
          heureSpan.textContent = currentText;
          return;
        }
        heureSpan.textContent = parsed;
        patchEvent(evenement.id, parsed);
      };
      const cancel = () => {
        if (done) return;
        done = true;
        heureSpan.textContent = currentText;
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          input.removeEventListener('blur', commit);
          cancel();
        }
      });
    });

    return line;
  }

  function makeEvenementsCell(evenements) {
    const td = document.createElement('td');
    td.className = 'band-cell';
    evenements.forEach((evenement) => td.appendChild(makeEvenementLine(evenement)));
    return td;
  }

  function makeCheckboxCell(date, field, checked) {
    const td = document.createElement('td');
    td.className = 'center';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.addEventListener('change', () => {
      patchDay(date, { [field]: input.checked });
    });
    td.appendChild(input);
    return td;
  }

  const fmtKm = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(1));
  const parseKm = (s) => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const fmtJauge = (v) => (v === null || v === undefined || v === '' ? '' : `${v}%`);
  const parseJauge = (s) => {
    const t = s.trim().replace('%', '');
    if (t === '') return null;
    const n = Math.round(Number(t));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  };
  const fmtText = (v) => v || '';
  const parseText = (s) => (s.trim() === '' ? null : s.trim());

  function renderVehiculeTable(days) {
    tableVehicule.innerHTML = '';
    const thead = document.createElement('thead');
    thead.innerHTML =
      '<tr><th>Date</th><th>Km départ</th><th>Km arrivée</th><th>Jauge départ</th><th>Jauge arrivée</th><th>Conducteur</th></tr>';
    tableVehicule.appendChild(thead);

    const tbody = document.createElement('tbody');
    days.forEach(({ date, vehicule }) => {
      const tr = document.createElement('tr');
      const tdDate = document.createElement('td');
      tdDate.textContent = formatDate(date);
      tr.appendChild(tdDate);
      tr.appendChild(makeEditableCell(date, 'km_depart', vehicule.km_depart, { format: fmtKm, parse: parseKm }));
      tr.appendChild(makeEditableCell(date, 'km_arrivee', vehicule.km_arrivee, { format: fmtKm, parse: parseKm }));
      tr.appendChild(makeEditableCell(date, 'jauge_depart', vehicule.jauge_depart, { format: fmtJauge, parse: parseJauge }));
      tr.appendChild(makeEditableCell(date, 'jauge_arrivee', vehicule.jauge_arrivee, { format: fmtJauge, parse: parseJauge }));
      tr.appendChild(makeEditableCell(date, 'conducteur', vehicule.conducteur, { format: fmtText, parse: parseText }));
      tbody.appendChild(tr);
    });
    tableVehicule.appendChild(tbody);
  }

  function renderActiviteTable(days) {
    tableActivite.innerHTML = '';
    const thead = document.createElement('thead');
    thead.innerHTML =
      '<tr>' +
      '<th rowspan="2">Date</th><th rowspan="2">0h-8h</th><th rowspan="2">8h-16h</th><th rowspan="2">16h-24h</th>' +
      '<th colspan="3">Repas</th><th colspan="2">Découche</th>' +
      '</tr><tr><th>P. déj.</th><th>Midi</th><th>Soir</th><th>Inter</th><th>Natio</th></tr>';
    tableActivite.appendChild(thead);

    const tbody = document.createElement('tbody');
    days.forEach(({ date, activite }) => {
      const tr = document.createElement('tr');
      const tdDate = document.createElement('td');
      tdDate.textContent = formatDate(date);
      tr.appendChild(tdDate);
      [activite.bande0, activite.bande1, activite.bande2].forEach((evenements) => {
        tr.appendChild(makeEvenementsCell(evenements));
      });
      tr.appendChild(makeCheckboxCell(date, 'petit_dejeuner', activite.petit_dejeuner));
      tr.appendChild(makeCheckboxCell(date, 'repas_midi', activite.repas_midi));
      tr.appendChild(makeCheckboxCell(date, 'repas_soir', activite.repas_soir));
      tr.appendChild(makeCheckboxCell(date, 'decouche_inter', activite.decouche_inter));
      tr.appendChild(makeCheckboxCell(date, 'decouche_natio', activite.decouche_natio));
      tbody.appendChild(tr);
    });
    tableActivite.appendChild(tbody);
  }

  async function fetchAndRenderMonth() {
    if (!API_BASE_URL || feuilleSection.hidden) return;
    try {
      const res = await authFetch(`${API_BASE_URL}/api/month/current`);
      if (!res.ok) return;
      const { days } = await res.json();
      renderVehiculeTable(days);
      renderActiviteTable(days);
    } catch (err) {
      // Pas grave si ça échoue au chargement : les deux boutons photo restent utilisables.
    }
  }

  btnEditToggle.addEventListener('click', () => {
    const opening = feuilleSection.hidden;
    feuilleSection.hidden = !opening;
    btnEditToggle.textContent = opening ? '✖️ Fermer la feuille' : '✏️ Modifier manuellement la feuille';
    if (opening) fetchAndRenderMonth();
  });

  if (authToken) {
    showApp();
    checkExistingPdf();
  } else {
    showLogin();
  }
})();
