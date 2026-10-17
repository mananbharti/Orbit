/** Privately persisted launcher scenes (named app groups); depends on private atomic storage; a corrupt file starts empty. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from '../security-pairing/atomic-file.js';
import { MAX_SCENES, launcherSceneSchema, type LauncherScene } from '../protocol/app-launcher.js';

export class LauncherScenes {
  private scenes: LauncherScene[] = [];

  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    try {
      const parsed = z.array(launcherSceneSchema).max(MAX_SCENES).safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) this.scenes = parsed.data;
    } catch { /* unreadable scenes are simply forgotten */ }
  }

  list(): LauncherScene[] { return this.scenes.map(scene => ({ ...scene, appIds: [...scene.appIds] })); }

  get(id: string): LauncherScene | undefined { return this.scenes.find(scene => scene.id === id); }

  /** Creates without an id, replaces with one. Names dedupe case-insensitively so "work" and "Work" cannot both exist. */
  save(name: string, appIds: string[], id?: string): LauncherScene[] {
    const clash = this.scenes.find(scene => scene.name.toLowerCase() === name.toLowerCase() && scene.id !== id);
    if (clash) throw new Error('LAUNCHER_SCENE_NAME_TAKEN');
    if (id) {
      const index = this.scenes.findIndex(scene => scene.id === id);
      if (index === -1) throw new Error('LAUNCHER_SCENE_NOT_FOUND');
      this.scenes[index] = { id, name, appIds: [...appIds] };
    } else {
      if (this.scenes.length >= MAX_SCENES) throw new Error('LAUNCHER_SCENE_LIMIT');
      this.scenes.push({ id: randomUUID(), name, appIds: [...appIds] });
    }
    this.persist();
    return this.list();
  }

  remove(id: string): LauncherScene[] {
    const next = this.scenes.filter(scene => scene.id !== id);
    if (next.length !== this.scenes.length) { this.scenes = next; this.persist(); }
    return this.list();
  }

  /** App ids persist across restarts, so scenes survive them; ids whose app vanished stay stored (the app may return). */
  private persist(): void { if (this.path) atomicWrite(this.path, JSON.stringify(this.scenes)); }
}
