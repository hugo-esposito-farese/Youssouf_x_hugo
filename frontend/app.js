(() => {
  const API_BASE_URL = (window.API_BASE_URL || '').replace(/\/$/, '');

  const btnDebut = document.getElementById('btn-debut');
  const btnFin = document.getElementById('btn-fin');
  const photoInput = document.getElementById('photo-input');
  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('result');
  const pdfLinkWrap = document.getElementById('pdf-link-wrap');
  const pdfLink = document.getElementById('pdf-link');

  let pendingType = null;

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

      const response = await fetch(`${API_BASE_URL}/api/events`, {
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
      pdfLink.href = `${API_BASE_URL}${data.pdfUrl}`;
      pdfLinkWrap.hidden = false;
    }
  }

  async function checkExistingPdf() {
    if (!API_BASE_URL) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/pdf/current-url`);
      if (!res.ok) return;
      const { pdfUrl } = await res.json();
      const head = await fetch(`${API_BASE_URL}${pdfUrl}`, { method: 'HEAD' });
      if (head.ok) {
        pdfLink.href = `${API_BASE_URL}${pdfUrl}`;
        pdfLinkWrap.hidden = false;
      }
    } catch (err) {
      // Pas grave si ça échoue au chargement : le lien réapparaîtra après le prochain jour clos.
    }
  }

  checkExistingPdf();
})();
