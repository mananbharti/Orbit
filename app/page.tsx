import type { ReactNode } from "react";
import { MotionControl, SiteHeader } from "./components/site-controls";

const repo = "https://github.com/mananbharti/Orbit";
const notifications = `${repo}/subscription`;

function OrbitMark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 44 44" fill="none" aria-hidden="true">
      <circle cx="22" cy="22" r="10.3" fill="currentColor" />
      <ellipse cx="22" cy="22" rx="20" ry="8.1" transform="rotate(-27 22 22)" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="36.8" cy="13.9" r="2.4" fill="#51b99d" />
    </svg>
  );
}

function StarIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.7 2.85 5.78 6.38.93-4.62 4.5 1.09 6.35L12 17.26l-5.7 3 1.09-6.35-4.62-4.5 6.38-.93L12 2.7Z" fill="currentColor" /></svg>;
}

function ArrowIcon({ diagonal = false }: { diagonal?: boolean }) {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d={diagonal ? "M5 15 15 5M6 5h9v9" : "M3 10h13m-5-5 5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function MiniWindow({ variant }: { variant: "clip" | "files" | "apps" | "mouse" | "device" }) {
  if (variant === "clip") return <div className="mini-window clip-window"><div className="mini-window-head"><span>CLIPBOARD</span><span className="live"><i /> SYNCED</span></div><div className="copied-text">“The little things add up.”</div><div className="mini-window-foot">Copied from <b>Phone</b><span>just now</span></div></div>;
  if (variant === "files") return <div className="mini-window file-window"><div className="mini-window-head"><span>SHARED FILES</span><span>···</span></div>{[["▧", "screenshots", "4 items"], ["▤", "notes.txt", "8 KB"], ["▣", "design.fig", "2.4 MB"]].map(([icon, name, size]) => <div className="file-row" key={name}><i>{icon}</i><span>{name}</span><small>{size}</small></div>)}</div>;
  if (variant === "apps") return <div className="mini-window apps-window"><div className="mini-window-head"><span>ON YOUR PC</span><span>⌕</span></div><div className="app-grid">{[["N", "Notes"], ["⌘", "Code"], ["◈", "Design"]].map(([icon, name]) => <div className="app-item" key={name}><i>{icon}</i><span>{name}</span></div>)}</div><div className="app-launch">App ready to launch <b>↗</b></div></div>;
  if (variant === "mouse") return <div className="mini-window mouse-window"><div className="mini-window-head"><span>REMOTE INPUT</span><span className="live"><i /> READY</span></div><div className="trackpad"><span className="mouse-cursor">↖</span><small>TRACKPAD</small></div><div className="mouse-keys"><b>◀</b><b>●</b><b>▶</b><span>Keyboard</span><span>Click</span></div></div>;
  return <div className="mini-window device-window"><div className="mini-window-head"><span>DEVICE</span><span>•••</span></div><div className="device-controls"><div><i>⏻</i><span>Power</span></div><div><i>☼</i><span>Display</span></div><div><i>♫</i><span>Volume</span></div></div><div className="volume-line"><span>Volume</span><i><b /></i><small>64%</small></div></div>;
}

function HeroMockup() {
  return (
    <div className="hero-stage" role="img" aria-label="Concept illustration of a future Orbit phone app and desktop client; the mobile app is not available yet">
      <div className="stage-halo" />
      <span className="hero-doodle doodle-a" aria-hidden="true">✳</span><span className="hero-doodle doodle-b" aria-hidden="true">·</span><span className="hero-doodle doodle-c" aria-hidden="true">✳</span><span className="hero-doodle doodle-d" aria-hidden="true">·</span>
      <div className="stage-note note-phone">YOUR PHONE <i>iOS · ANDROID</i></div>
      <div className="phone-mock"><div className="phone-shell"><div className="phone-notch"/><div className="phone-status"><span>9:41</span><span>▴ ▰</span></div><div className="phone-head"><div><small>GOOD MORNING</small><b>Your devices</b></div><span className="avatar">o</span></div><div className="phone-device active-device"><span className="device-square">▰</span><span><b>Studio PC</b><small>Connected · nearby</small></span><i /></div><div className="phone-short-label">QUICK ACTIONS</div><div className="phone-action-grid"><span><i>↔</i>Clipboard</span><span><i>↗</i>Send file</span><span><i>⌘</i>Control</span><span><i>◈</i>Apps</span></div><div className="phone-nav"><i>⌂</i><i>▰</i><i>◉</i><i>⚙</i></div></div><div className="phone-shadow"/></div>
      <div className="computer-mock"><div className="monitor"><div className="monitor-top"><span className="window-controls"><i/><i/><i/></span><span>orbit · devices</span><span>⌕　···</span></div><div className="monitor-body"><aside className="monitor-sidebar"><div className="monitor-brand"><OrbitMark/> orbit</div><span className="selected">◈　Devices</span><span>↔　Clipboard</span><span>↗　Files</span><span>⌘　Controls</span><div className="sidebar-bottom">●　Paired locally</div></aside><div className="monitor-main"><div className="monitor-title"><span><small>YOUR ORBIT</small><b>Devices</b></span><span className="pair-button">＋ Pair device</span></div><div className="desktop-card"><span className="computer-icon">▰</span><span><b>Pixel 9</b><small>Android · connected now</small></span><i>•••</i></div><div className="desktop-card"><span className="computer-icon mint-icon">▱</span><span><b>This computer</b><small>Windows · this device</small></span><i>•••</i></div><div className="desktop-clip"><div><span>RECENT CLIPBOARD</span><span>•••</span></div><p>“The little things add up.”</p><small>Copied from Pixel 9 <b>just now</b></small></div></div></div></div><div className="monitor-stand"/><div className="monitor-base"/></div>
      <div className="connection-path"><span className="path-line"/><span className="path-glow"/><div className="transfer-card"><i>↔</i><span>copied on phone</span><b>pasted on PC</b></div><div className="local-chip"><i/> LOCAL CONNECTION</div></div>
      <div className="stage-note note-pc">YOUR COMPUTER <i>WINDOWS · LINUX</i></div>
      <div className="stage-caption">Concept preview · the Orbit mobile app is not built yet.</div>
    </div>
  );
}

function AgentIllustration() {
  return <div className="agent-visual"><div className="agent-chat"><div className="chat-top"><span className="agent-orbit"><OrbitMark/></span><span><b>Orbit agent</b><small>ON YOUR COMPUTER</small></span><span className="soon-pill">COMING SOON</span></div><div className="user-prompt"><span>YOU</span><p>Move these screenshots to my project folder.</p></div><div className="agent-response"><span className="agent-spark">✳</span><div><small>ORBIT</small><p>On it. I found 4 screenshots from today.</p><div className="action-row"><i>✓</i><span>Found 4 screenshots</span></div><div className="action-row"><i>✓</i><span>Opened project folder</span></div><div className="action-row action-done"><i>↗</i><span>Moved files into <b>/project/screenshots</b></span></div></div></div><div className="chat-composer"><span>Ask Orbit to do something…</span><b>↑</b></div></div><div className="agent-desktop"><div className="agent-desktop-bar"><span><i/><i/><i/></span> project folder</div><div className="folder-head"><span>NAME</span><span>MODIFIED</span></div>{["Screenshot 01.png", "Screenshot 02.png", "Screenshot 03.png", "Screenshot 04.png"].map((name, i) => <div className="folder-file" key={name}><span><i>▧</i>{name}</span><small>{i === 0 ? "Just now" : "Today"}</small></div>)}<div className="folder-status"><i/> 4 files moved by Orbit</div></div><div className="agent-path"><span/><i>PLAIN LANGUAGE → ACTIONS</i><span/></div></div>;
}

function PrivacyIcon({ kind }: { kind: string }) {
  const paths: Record<string, ReactNode> = {
    local: <><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.2 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.2-3.3-8.5S9.8 5.9 12 3.5Z"/></>,
    lock: <><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v2"/></>,
    code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14"/></>,
    data: <><path d="M12 3 4.5 6v5.3c0 4.5 3.2 7.7 7.5 9.7 4.3-2 7.5-5.2 7.5-9.7V6L12 3Z"/><path d="m8.5 12 2.2 2.2 4.8-4.8"/></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

export default function Home() {
  return (
    <main className="site antialiased">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SiteHeader />

      <div id="main-content">
        <section className="hero-section" id="top">
          <div className="hero-content">
            <div className="dev-pill"><span className="dev-dot"/> CURRENTLY IN DEVELOPMENT</div>
            <h1>Meet <span>Orbit.</span></h1>
            <p className="hero-subtitle">Orbit is building a local, encrypted connection<br className="desktop-break"/> between your phone and computer.<br/><span className="hero-status-note">The desktop foundation is taking shape. Orbit Mobile is still ahead.</span></p>
            <div className="hero-buttons"><a href={repo} target="_blank" rel="noreferrer" className="button button-dark"><StarIcon/> Star on GitHub <ArrowIcon diagonal/></a><a href={notifications} target="_blank" rel="noreferrer" className="button button-secondary">Get notified <ArrowIcon/></a></div>
            <div className="hero-proof"><span>OPEN SOURCE</span><i/> <span>FREEMIUM</span><i/> <span>FOUNDER-BUILT</span></div>
          </div>
          <HeroMockup/>
          <MotionControl />
        </section>

        <section className="why-section section-shell" id="how"><div className="why-label"><span className="eyebrow-index">01 / WHY ORBIT</span><span className="tiny-orbit"><OrbitMark/></span></div><div className="why-copy"><h2>Continuity for<br/>every <em>device.</em></h2><div><p>Emailing files to yourself is a workaround. Cloud middlemen add a detour. And a full remote desktop can be more than you need.</p><p>Orbit is designed to bring clipboard, files and practical controls together over a local, encrypted connection. Today, the desktop service and its integration client are the foundation; the phone app is a later phase.</p></div></div></section>

        <section className="features-section section-shell" id="features"><div className="section-heading"><div><span className="eyebrow-index">02 / V1 ROADMAP</span><h2>Useful handoffs.<br/><em>Built in stages.</em></h2></div><p>These are the planned product features. The status on each card separates desktop-service work from what is still ahead.</p></div><div className="bento-grid">
          <article className="bento-card card-clipboard"><div className="bento-copy"><span className="card-number">01 <i>DESKTOP · P3</i></span><h3>Clipboard<br/>sync</h3><p>Bidirectional plain-text sync. Windows verified; Linux validation remains open.</p></div><MiniWindow variant="clip"/><span className="bento-scribble">↗</span></article>
          <article className="bento-card card-files"><div className="bento-copy"><span className="card-number">02 <i>DESKTOP · P4</i></span><h3>File sharing</h3><p>Direct, resumable transfers. Windows verified; Linux validation remains open.</p></div><MiniWindow variant="files"/></article>
          <article className="bento-card card-apps"><div className="bento-copy"><span className="card-number">03 <i>DESKTOP · P5</i></span><h3>App launching</h3><p>The desktop service can list and request activation of registered apps.</p></div><MiniWindow variant="apps"/></article>
          <article className="bento-card card-mouse"><div className="bento-copy"><span className="card-number">04 <i>NOT WIRED</i></span><h3>Mouse &amp;<br/>keyboard</h3><p>Input adapters are in development; remote controls are not connected to the service yet.</p></div><MiniWindow variant="mouse"/></article>
          <article className="bento-card card-device"><div className="bento-copy"><span className="card-number">05 <i>FUTURE PHASE</i></span><h3>Device controls</h3><p>Power and session controls are part of the roadmap, not available today.</p></div><MiniWindow variant="device"/><span className="device-spark">✳</span></article>
        </div><p className="feature-footnote"><span>✳</span> UI mockups show product direction, not a released app. Orbit does not mirror screens.</p></section>

        <section className="agent-section"><div className="agent-inner section-shell"><div className="agent-copy"><span className="eyebrow-index light-index">03 / FUTURE ROADMAP</span><div className="coming-badge"><span/> FUTURE · NOT IMPLEMENTED</div><h2>Describe a task.<br/><em>Orbit does the busywork.</em></h2><p>A future AI agent layer, built on Claude, is planned to let you describe a task in plain language and have Orbit carry it out on the paired computer. It is not part of the current build.</p><a className="agent-link" href={notifications} target="_blank" rel="noreferrer">Follow development <ArrowIcon/></a><span className="agent-disclaimer">Illustration only · no agent actions are available yet.</span></div><AgentIllustration/></div></section>

        <section className="privacy-section section-shell"><div className="privacy-heading"><span className="eyebrow-index">04 / YOUR DEVICES, YOUR DATA</span><span className="privacy-orbit"><OrbitMark/></span><h2>Local <em>by design.</em></h2><p>Orbit v1 is designed to operate entirely over your local network. The desktop service uses QR-approved pairing and an encrypted, certificate-pinned channel. The mobile implementation is still ahead.</p></div><div className="privacy-grid">{[["local", "No cloud relay", "The desktop service does not route content through a third-party cloud."], ["lock", "Encrypted channel", "Desktop connections use TLS and verify the paired service identity."], ["code", "Open source", "Inspect the desktop service and follow the work in public."], ["data", "Data stays local", "The service does not send clipboard or file contents to external services."]].map(([kind, title, copy]) => <article className="privacy-card" key={kind}><PrivacyIcon kind={kind}/><h3>{title}</h3><p>{copy}</p></article>)}</div></section>

        <section className="contribute-section" id="contribute"><div className="contribute-inner section-shell"><div className="contribute-mark"><OrbitMark/><span>OPEN SOURCE · FOUNDER-BUILT</span></div><div className="contribute-copy"><span className="eyebrow-index light-index">05 / HELP SHAPE ORBIT</span><h2>Built in<br/><em>public.</em></h2><p>The desktop service is real work in progress; the mobile app and real-phone validation are still ahead. Explore the code, help test the Windows and Linux integrations, report an issue, or contribute a fix.</p><div className="contribute-buttons"><a href={repo} target="_blank" rel="noreferrer" className="button button-light"><StarIcon/> Star the repo <ArrowIcon diagonal/></a><a href={repo} target="_blank" rel="noreferrer" className="button button-outline">View on GitHub <ArrowIcon diagonal/></a></div><a className="chai-link" href="https://buymeachai.in/mananbharti" target="_blank" rel="noreferrer"><span>☕</span> Buy me a chai <ArrowIcon diagonal/></a></div><div className="contribute-aside"><span className="aside-spark">✳</span><p>“Continuity for every device — not just Apple’s.”</p><span className="aside-signature">THE ORBIT PROJECT</span></div></div></section>

        <section className="final-section" id="download"><div className="final-panel"><div className="final-orbit final-orbit-one"/><div className="final-orbit final-orbit-two"/><span className="eyebrow-index">IN ACTIVE DEVELOPMENT · PRE-LAUNCH</span><h2>Help build<br/><em>the next phase.</em></h2><p>Explore the desktop foundation, follow the roadmap, and help Orbit reach its first public release.</p><div className="final-actions"><a href={repo} target="_blank" rel="noreferrer" className="button button-dark"><StarIcon/> Star Orbit on GitHub <ArrowIcon diagonal/></a><a href={notifications} target="_blank" rel="noreferrer" className="final-notify">Follow development <ArrowIcon/></a></div><span className="final-note">NO PUBLIC MOBILE DOWNLOAD YET</span></div></section>
      </div>

      <footer className="footer"><div className="footer-main section-shell"><div className="footer-brand-col"><a className="wordmark footer-wordmark" href="#top"><OrbitMark/><span>orbit</span></a><p>A little more in sync.<br/>Built for your mix of devices.</p><span className="footer-dev"><i/> IN DEVELOPMENT · DESKTOP FIRST</span></div><div className="footer-col"><h3>PRODUCT</h3><a href="#features">Features</a><a href="#download">Download <small>NOT YET</small></a><a href={repo + "#roadmap"} target="_blank" rel="noreferrer">Roadmap <ArrowIcon diagonal/></a></div><div className="footer-col"><h3>CONTRIBUTE</h3><a href={repo} target="_blank" rel="noreferrer">GitHub <ArrowIcon diagonal/></a><a href={repo + "/issues"} target="_blank" rel="noreferrer">Issues <ArrowIcon diagonal/></a><a href={repo + "/discussions"} target="_blank" rel="noreferrer">Discussions <ArrowIcon diagonal/></a><a href="https://discord.gg/xQ3VaAnmPA" target="_blank" rel="noreferrer">Discord <ArrowIcon diagonal/></a></div><div className="footer-col"><h3>SUPPORT</h3><a href="https://buymeachai.in/mananbharti" target="_blank" rel="noreferrer">Buy me a chai <ArrowIcon diagonal/></a><a href={repo + "/issues"} target="_blank" rel="noreferrer">Contact <ArrowIcon diagonal/></a><div className="social-links"><a href={repo} target="_blank" rel="noreferrer" aria-label="GitHub"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.56.1.76-.24.76-.54v-2.08c-3.1.67-3.76-1.31-3.76-1.31-.5-1.28-1.24-1.62-1.24-1.62-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.71 2.62 1.22 3.26.93.1-.73.39-1.22.71-1.5-2.47-.28-5.07-1.24-5.07-5.5 0-1.22.44-2.21 1.16-2.99-.12-.28-.5-1.42.11-2.95 0 0 .95-.3 3.05 1.14a10.6 10.6 0 0 1 5.56 0c2.11-1.43 3.05-1.14 3.05-1.14.61 1.53.23 2.67.11 2.95.72.78 1.16 1.77 1.16 2.99 0 4.27-2.6 5.22-5.08 5.49.4.35.75 1.03.75 2.08v3.08c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/></svg></a><a href="https://www.linkedin.com/search/results/all/?keywords=Orbit" target="_blank" rel="noreferrer" aria-label="Search for Orbit on LinkedIn"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2ZM8.34 18H5.67V9.4h2.67V18ZM7 8.23a1.55 1.55 0 1 1 .02-3.1 1.55 1.55 0 0 1-.02 3.1ZM18.34 18h-2.67v-4.18c0-1-.02-2.28-1.39-2.28-1.39 0-1.6 1.08-1.6 2.2V18h-2.67V9.4h2.56v1.18h.04a2.8 2.8 0 0 1 2.52-1.39c2.7 0 3.2 1.78 3.2 4.1V18Z"/></svg></a><a href="https://x.com/search?q=Orbit" target="_blank" rel="noreferrer" aria-label="Search for Orbit on X"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.77 7.74L23.2 22h-6.25l-4.9-7.36L5.6 22H2.47l7.24-8.28L1.8 2h6.4l4.43 6.75L18.9 2Zm-1.1 17.87h1.73L7.28 4H5.42l12.38 15.87Z"/></svg></a></div></div></div><div className="footer-bottom section-shell"><span>© 2026 Orbit. Built with care, in the open.</span><span>Apache 2.0 · Made for the devices you already own.</span><a href="#top" aria-label="Back to top">BACK TO TOP ↑</a></div></footer>
    </main>
  );
}
