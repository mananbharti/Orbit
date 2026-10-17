/** Defines App Launcher wire contracts; depends on Zod; does not discover applications or authorize OS activation. */
import { z } from 'zod';

export const APP_PAGE_SIZE = 32;
export const MAX_APPS = 2_048;
export const appIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const catalogRevisionSchema = z.string().uuid();
export const appNameSchema = z.string().min(1).max(256).refine(value => Buffer.byteLength(value, 'utf8') <= 256
  && !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value));
export const listAppsSchema = z.strictObject({ cursor: z.string().max(48).regex(/^[a-f0-9-]{36}:[0-9]{1,4}$/).optional() });
export const launchAppSchema = z.strictObject({ appId: appIdSchema, catalogRevision: catalogRevisionSchema });
export const appPageSchema = z.strictObject({ catalogRevision: catalogRevisionSchema,
  apps: z.array(z.strictObject({ appId: appIdSchema, name: appNameSchema })).max(APP_PAGE_SIZE),
  nextCursor: z.string().max(48).nullable(), pinned: z.array(appIdSchema).max(24) });
export const launchResultSchema = z.strictObject({ status: z.literal('requested') });
export const appIconSchema = z.strictObject({ appId: appIdSchema, catalogRevision: catalogRevisionSchema });
/** Base64 PNG at 48x48; null when the app has no extractable icon. */
export const ICON_MAX_BASE64 = 90_000;
export const appIconResultSchema = z.strictObject({ icon: z.string().base64().max(ICON_MAX_BASE64).nullable() });
/** One icon request per app would take one round trip each; a batch of 8 fits the 64KB message cap with headroom. */
export const ICON_BATCH_SIZE = 8;
export const appIconsSchema = z.strictObject({ appIds: z.array(appIdSchema).min(1).max(ICON_BATCH_SIZE), catalogRevision: catalogRevisionSchema });
export const appIconsResultSchema = z.strictObject({ icons: z.record(appIdSchema, z.string().base64().max(ICON_MAX_BASE64).nullable()) });
export type AppPage = z.infer<typeof appPageSchema>;

/** Pinned favourites: ordered app ids, shared by every paired phone, capped so one row of the grid stays scannable. */
export const MAX_PINS = 24;
export const pinAppSchema = z.strictObject({ appId: appIdSchema });
export const reorderAppsSchema = z.strictObject({ appIds: z.array(appIdSchema).min(1).max(MAX_PINS) });
export const launcherLayoutSchema = z.strictObject({ pinned: z.array(appIdSchema).max(MAX_PINS) });

/** Scenes: named groups of apps that launch together (e.g. "Work" opens Slack + VS Code + Chrome). */
export const MAX_SCENES = 20;
export const MAX_SCENE_APPS = 12;
export const sceneNameSchema = z.string().min(1).max(40).refine(value => !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value));
export const sceneIdSchema = z.string().uuid();
export const launcherSceneSchema = z.strictObject({ id: sceneIdSchema, name: sceneNameSchema,
  appIds: z.array(appIdSchema).min(1).max(MAX_SCENE_APPS) });
export const saveSceneSchema = z.strictObject({ id: sceneIdSchema.optional(), name: sceneNameSchema,
  appIds: z.array(appIdSchema).min(1).max(MAX_SCENE_APPS) });
export const sceneIdPayloadSchema = z.strictObject({ id: sceneIdSchema });
export const launcherScenesSchema = z.strictObject({ scenes: z.array(launcherSceneSchema).max(MAX_SCENES) });
export const sceneLaunchResultSchema = z.strictObject({ launched: z.number().int().min(0).max(MAX_SCENE_APPS),
  failed: z.array(appNameSchema).max(MAX_SCENE_APPS) });
export type LauncherScene = z.infer<typeof launcherSceneSchema>;
