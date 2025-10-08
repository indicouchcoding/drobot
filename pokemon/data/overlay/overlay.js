/* DroMon overlay client (polling) */
(() => {
  const sprite = document.getElementById('sprite');
  const label  = document.getElementById('label');

  let lastUrl = '';
  let lastLabel = '';
  let lastActive = false;

  async function getState() {
    try {
      const r = await fetch('/overlay/state', { cache:'no-store' });
      if (!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    } catch (e) {
      console.warn('[overlay] state failed:', e.message || e);
      return { active:false };
    }
  }

  function show(src, name, rarity, endsIn) {
    if (src !== lastUrl) {
      sprite.className = 'hidden';
      sprite.src = src;
      lastUrl = src;
      sprite.onload = () => { sprite.className = 'visible'; };
    }
    const lbl = `${name} · ${rarity} · ${endsIn}s`;
    if (lbl !== lastLabel) {
      label.textContent = lbl;
      label.className = 'label visible';
      lastLabel = lbl;
    }
  }

  function hide() {
    if (lastActive) {
      sprite.className = 'hidden';
      label.className = 'label hidden';
      lastUrl = '';
      lastLabel = '';
    }
  }

  async function tick() {
    const s = await getState();
    if (s.active) {
      show(s.spriteUrl, s.name, s.rarity, s.endsIn ?? 0);
      lastActive = true;
    } else {
      hide();
      lastActive = false;
    }
  }

  setInterval(tick, 1000);
  tick();
})();
