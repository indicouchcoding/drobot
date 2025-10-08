(() => {
  const STATE_URL = '/overlay/state';
  const POLL_MS = 1000;

  const root = document.getElementById('overlay-root');
  const card = document.getElementById('card');
  const img = document.getElementById('spawn-img');
  const nameEl = document.getElementById('name');
  const rarityEl = document.getElementById('rarity');
  const shinyEl = document.getElementById('shiny');
  const typesEl = document.getElementById('types');
  const timerEl = document.getElementById('timer');

  let lastKey = null;
  let hideTimer = null;

  function fmtTypes(arr){
    if (!Array.isArray(arr) || !arr.length) return '';
    return arr.join(' / ');
  }
  function fmtSecs(msLeft){
    const s = Math.max(0, Math.ceil(msLeft/1000));
    return `${s}s left`;
  }
  function scheduleHide(atMs){
    clearTimeout(hideTimer);
    const wait = Math.max(0, atMs - Date.now());
    hideTimer = setTimeout(() => {
      card.classList.add('hide');
      setTimeout(() => {
        root.classList.add('hidden');
        card.classList.remove('hide');
      }, 290);
    }, wait);
  }

  async function fetchState(){
    const r = await fetch(STATE_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function tick(){
    try {
      const s = await fetchState();
      if (!s || !s.active){
        clearTimeout(hideTimer);
        root.classList.add('hidden');
        return;
      }

      const key = `${s.dex}:${s.shiny?1:0}:${s.endsAt||s.hideAt||0}:${s.imageUrl||''}`;
      const firstPaint = (lastKey !== key);
      lastKey = key;

      if (firstPaint && s.imageUrl){
        await new Promise((resolve) => {
          const tmp = new Image();
          tmp.onload = () => resolve();
          tmp.onerror = () => resolve();
          tmp.src = s.imageUrl;
        });
      }

      nameEl.textContent = s.name || 'Unknown';
      rarityEl.textContent = s.rarity || '';
      shinyEl.style.display = s.shiny ? 'inline-flex' : 'none';
      typesEl.textContent = fmtTypes(s.types);

      if (s.imageUrl) img.src = s.imageUrl;

      root.classList.remove('hidden');
      if (firstPaint){
        card.classList.remove('hide');
        card.classList.remove('pop');
        void card.offsetWidth;
        card.classList.add('pop');
      }

      const end = s.endsAt || s.hideAt || 0;
      if (end > 0) {
        const msLeft = end - Date.now();
        timerEl.textContent = fmtSecs(msLeft);
        scheduleHide(end);
      } else {
        timerEl.textContent = '';
        clearTimeout(hideTimer);
      }
    } catch (e) {
      // ignore
    } finally {
      setTimeout(tick, POLL_MS);
    }
  }

  tick();
})();