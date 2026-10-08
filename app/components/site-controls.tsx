"use client";

import { useState } from "react";

const repo = "https://github.com/mananbharti/Orbit";

function OrbitMark() {
  return <svg viewBox="0 0 44 44" fill="none" aria-hidden="true"><circle cx="22" cy="22" r="10.3" fill="currentColor"/><ellipse cx="22" cy="22" rx="20" ry="8.1" transform="rotate(-27 22 22)" stroke="currentColor" strokeWidth="2.4"/><circle cx="36.8" cy="13.9" r="2.4" fill="#51b99d"/></svg>;
}

function StarIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.7 2.85 5.78 6.38.93-4.62 4.5 1.09 6.35L12 17.26l-5.7 3 1.09-6.35-4.62-4.5 6.38-.93L12 2.7Z" fill="currentColor"/></svg>;
}

function ArrowIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M6 5h9v9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return <header className="topbar"><div className="nav-shell">
    <a className="wordmark" href="#top" aria-label="Orbit home"><OrbitMark/><span>orbit</span></a>
    <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-controls="primary-navigation" aria-label={menuOpen ? "Close navigation" : "Open navigation"}><span/><span/></button>
    <nav className={menuOpen ? "nav-links nav-open" : "nav-links"} id="primary-navigation" aria-label="Main navigation">
      <a onClick={closeMenu} href="#features">Features</a><a onClick={closeMenu} href="#how">How it works</a><a onClick={closeMenu} href="#contribute">Contribute</a><a onClick={closeMenu} href="#download">Download <span className="nav-soon">NOT RELEASED</span></a>
    </nav>
    <a className="nav-star" href={repo} target="_blank" rel="noreferrer"><StarIcon/><span>Star on GitHub</span><b aria-label="Star count coming soon">—</b></a>
  </div></header>;
}

export function MotionControl() {
  const [paused, setPaused] = useState(false);
  const toggleMotion = () => {
    const nextPaused = !paused;
    setPaused(nextPaused);
    document.documentElement.classList.toggle("motion-paused", nextPaused);
  };

  return <button className="motion-control" onClick={toggleMotion} aria-pressed={paused}><span>{paused ? "▶" : "Ⅱ"}</span>{paused ? "Play motion" : "Pause motion"}</button>;
}
