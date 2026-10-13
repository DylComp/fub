import { useEffect, useState } from "react";

const phrases = ["Trade. Pay. Launch.", "Plan your exits.", "Follow Fomo traders.", "Split the bill.", "Launch for a trader."];

export function HubHeadline() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (!motion.matches && !paused && !document.hidden)
        timer = setInterval(() => setIndex(value => (value + 1) % phrases.length), 3000);
      if (motion.matches) setIndex(0);
    };
    sync();
    motion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => { clearInterval(timer); motion.removeEventListener("change", sync); document.removeEventListener("visibilitychange", sync); };
  }, [paused]);
  return <h1 id="hub-title" aria-label="Your Fomo hub. Trade. Pay. Launch.">
    Your Fomo hub.<br />
    <button type="button" className="hub-headline-rotation" aria-label={paused ? "Resume headline animation" : "Pause headline animation"} aria-pressed={paused} onClick={() => setPaused(value => !value)}>
      <span className="hub-headline-size" aria-hidden="true">Follow Fomo traders.</span>
      <span key={index} className="hub-headline-word" aria-hidden="true">{phrases[index]}</span>
    </button>
  </h1>;
}
