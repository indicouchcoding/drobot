async function fetchState() {
  const r = await fetch("/overlay/state", { cache: "no-store" });
  return r.json();
}

