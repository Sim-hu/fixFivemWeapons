import type { ConflictGroup, ResolvedFile } from "./resource-builder";
import { sanitizeResourceName } from "./resource-builder";
import { STREAM_EXTENSIONS, getBaseName, getExtension } from "./types";

export type WeaponOutputMode = "addon" | "replace";

interface ReplaceWeaponProfile {
  modelBase: string;
  weaponName: string;
  addonModelPrefix: string;
  audio: string;
  slot: string;
  group: string;
  ammoInfo: string;
  aimingInfo: string;
  clipSize: number;
}

export interface ReplaceWeaponInfo {
  modelBase: string;
  weaponName: string;
  suggestedAddonSlug: string;
  suggestedAddonWeaponName: string;
  suggestedAddonModelBase: string;
}

interface WeaponComponentDefinition {
  name: string;
  model: string;
  kind: "clip" | "suppressor";
  clipSize?: number;
}

const REPLACE_WEAPON_PROFILES: ReplaceWeaponProfile[] = [
  {
    modelBase: "w_sb_smg",
    weaponName: "WEAPON_SMG",
    addonModelPrefix: "w_sb",
    audio: "AUDIO_ITEM_SMG",
    slot: "SLOT_SMG",
    group: "GROUP_SMG",
    ammoInfo: "AMMO_SMG",
    aimingInfo: "SMG_AIMING",
    clipSize: 30,
  },
  {
    modelBase: "w_sb_microsmg",
    weaponName: "WEAPON_MICROSMG",
    addonModelPrefix: "w_sb",
    audio: "AUDIO_ITEM_MICROSMG",
    slot: "SLOT_MICROSMG",
    group: "GROUP_SMG",
    ammoInfo: "AMMO_SMG",
    aimingInfo: "SMG_AIMING",
    clipSize: 16,
  },
  {
    modelBase: "w_ar_carbinerifle",
    weaponName: "WEAPON_CARBINERIFLE",
    addonModelPrefix: "w_ar",
    audio: "AUDIO_ITEM_CARBINERIFLE",
    slot: "SLOT_CARBINERIFLE",
    group: "GROUP_RIFLE",
    ammoInfo: "AMMO_RIFLE",
    aimingInfo: "RIFLE_CARBINE_RIFLE_AIMING",
    clipSize: 30,
  },
  {
    modelBase: "w_ar_assaultrifle",
    weaponName: "WEAPON_ASSAULTRIFLE",
    addonModelPrefix: "w_ar",
    audio: "AUDIO_ITEM_ASSAULTRIFLE",
    slot: "SLOT_ASSAULTRIFLE",
    group: "GROUP_RIFLE",
    ammoInfo: "AMMO_RIFLE",
    aimingInfo: "RIFLE_CARBINE_RIFLE_AIMING",
    clipSize: 30,
  },
  {
    modelBase: "w_pi_pistol",
    weaponName: "WEAPON_PISTOL",
    addonModelPrefix: "w_pi",
    audio: "AUDIO_ITEM_PISTOL",
    slot: "SLOT_PISTOL",
    group: "GROUP_PISTOL",
    ammoInfo: "AMMO_PISTOL",
    aimingInfo: "PISTOL_2H_BASE_STRAFE",
    clipSize: 12,
  },
];

const ATTACHMENT_MODEL_PREFIXES = ["w_at_pi_supp", "w_at_ar_supp", "w_at_ar_supp_02", "w_at_sr_supp"];

export function detectReplaceWeapon(
  resolved: ResolvedFile[],
  conflicts: ConflictGroup[],
  sourceFileName: string,
): ReplaceWeaponInfo | null {
  const files = flattenAnalyzeFiles(resolved, conflicts);
  if (files.some((file) => /(^|\/)weapon(?:archetypes|components|animations|s)[^/]*\.meta$/i.test(file.resourcePath))) {
    return null;
  }

  const counts = new Map<string, number>();
  for (const file of files) {
    for (const path of [file.sourcePath, file.resourcePath]) {
      const ext = getExtension(path);
      if (!STREAM_EXTENSIONS.has(ext)) continue;
      const stem = stripStreamVariantSuffix(getStem(path));
      const profile = findReplaceWeaponProfileForStem(stem);
      if (profile) counts.set(profile.modelBase, (counts.get(profile.modelBase) ?? 0) + 1);
    }
  }

  let bestProfile: ReplaceWeaponProfile | null = null;
  let bestCount = 0;
  for (const [modelBase, count] of counts) {
    const profile = getReplaceWeaponProfile(modelBase);
    if (!profile) continue;
    if (count > bestCount) {
      bestProfile = profile;
      bestCount = count;
    }
  }
  if (!bestProfile) return null;

  const suggestedAddonSlug = sanitizeAddonWeaponSlug(sourceFileName, bestProfile);
  return {
    modelBase: bestProfile.modelBase,
    weaponName: bestProfile.weaponName,
    suggestedAddonSlug,
    suggestedAddonWeaponName: makeAddonWeaponName(suggestedAddonSlug),
    suggestedAddonModelBase: makeAddonModelBase(bestProfile, suggestedAddonSlug),
  };
}

export function buildWeaponOutputFiles(
  files: ResolvedFile[],
  options: {
    addonSlug: string;
    replaceWeapon: ReplaceWeaponInfo | null;
    weaponOutputMode: WeaponOutputMode;
  },
): ResolvedFile[] {
  if (options.weaponOutputMode === "replace" || !options.replaceWeapon) return files;
  const profile = getReplaceWeaponProfile(options.replaceWeapon.modelBase);
  if (!profile) return files;
  return convertReplaceWeaponToAddon(files, profile, options.addonSlug || options.replaceWeapon.suggestedAddonSlug);
}

function flattenAnalyzeFiles(
  resolved: ResolvedFile[],
  conflicts: ConflictGroup[],
): Array<Pick<ResolvedFile, "resourcePath" | "sourcePath">> {
  const files: Array<Pick<ResolvedFile, "resourcePath" | "sourcePath">> = [...resolved];
  for (const conflict of conflicts) {
    for (const candidate of conflict.candidates) {
      files.push({ resourcePath: conflict.resourcePath, sourcePath: candidate.sourcePath });
    }
  }
  return files;
}

function convertReplaceWeaponToAddon(files: ResolvedFile[], profile: ReplaceWeaponProfile, rawAddonSlug: string): ResolvedFile[] {
  const addonSlug = sanitizeAddonWeaponSlug(rawAddonSlug, profile);
  const addonModelBase = makeAddonModelBase(profile, addonSlug);
  const addonWeaponName = makeAddonWeaponName(addonSlug);

  const converted = files.map((file) => ({
    ...file,
    resourcePath: renameReplaceWeaponStreamPath(file.resourcePath, profile, addonModelBase, addonSlug),
  }));
  const resourcePaths = new Set(converted.map((file) => file.resourcePath.toLowerCase()));
  const componentDefinitions = detectGeneratedWeaponComponents(converted, addonModelBase, addonSlug, profile.clipSize);
  const generatedFiles: ResolvedFile[] = [];
  const encoder = new TextEncoder();

  addGeneratedDataFile(
    generatedFiles,
    resourcePaths,
    "data/weapons.meta",
    buildGeneratedWeaponsMeta(profile, addonWeaponName, addonModelBase, componentDefinitions),
    encoder,
  );
  addGeneratedDataFile(
    generatedFiles,
    resourcePaths,
    "data/weaponarchetypes.meta",
    buildGeneratedWeaponArchetypesMeta(addonModelBase, componentDefinitions),
    encoder,
  );
  if (componentDefinitions.length > 0) {
    addGeneratedDataFile(
      generatedFiles,
      resourcePaths,
      "data/weaponcomponents.meta",
      buildGeneratedWeaponComponentsMeta(componentDefinitions),
      encoder,
    );
  }

  return [...converted, ...generatedFiles].sort((a, b) => a.resourcePath.localeCompare(b.resourcePath));
}

function addGeneratedDataFile(
  generatedFiles: ResolvedFile[],
  resourcePaths: Set<string>,
  resourcePath: string,
  content: string,
  encoder: TextEncoder,
): void {
  if (resourcePaths.has(resourcePath.toLowerCase())) return;
  resourcePaths.add(resourcePath.toLowerCase());
  generatedFiles.push({
    resourcePath,
    sourcePath: `generated/${resourcePath}`,
    data: encoder.encode(content),
  });
}

function renameReplaceWeaponStreamPath(
  resourcePath: string,
  profile: ReplaceWeaponProfile,
  addonModelBase: string,
  addonSlug: string,
): string {
  if (!resourcePath.startsWith("stream/")) return resourcePath;
  const segments = resourcePath.split("/");
  const fileName = segments.at(-1);
  if (!fileName) return resourcePath;
  const ext = getExtension(fileName);
  if (!STREAM_EXTENSIONS.has(ext)) return resourcePath;
  const stem = getStem(fileName);
  const renamedStem = renameReplaceWeaponStem(stem, profile, addonModelBase, addonSlug);
  if (!renamedStem || renamedStem === stem) return resourcePath;
  return [...segments.slice(0, -1), `${renamedStem}.${ext}`].join("/");
}

function renameReplaceWeaponStem(
  stem: string,
  profile: ReplaceWeaponProfile,
  addonModelBase: string,
  addonSlug: string,
): string | null {
  const lowerStem = stem.toLowerCase();
  const lowerModelBase = profile.modelBase.toLowerCase();
  if (lowerStem === lowerModelBase) return addonModelBase;
  if (lowerStem.startsWith(`${lowerModelBase}_`) || lowerStem.startsWith(`${lowerModelBase}+`)) {
    return `${addonModelBase}${stem.slice(profile.modelBase.length)}`;
  }

  for (const attachmentPrefix of ATTACHMENT_MODEL_PREFIXES) {
    const lowerAttachmentPrefix = attachmentPrefix.toLowerCase();
    if (lowerStem === lowerAttachmentPrefix || lowerStem.startsWith(`${lowerAttachmentPrefix}_`)) {
      const suffix = stem.slice(attachmentPrefix.length);
      const attachmentKind = attachmentPrefix.replace(/^w_at_[a-z]+_/, "");
      return `w_at_${addonSlug}_${attachmentKind}${suffix}`;
    }
  }

  return null;
}

function detectGeneratedWeaponComponents(
  files: ResolvedFile[],
  addonModelBase: string,
  addonSlug: string,
  baseClipSize: number,
): WeaponComponentDefinition[] {
  const streamModelStems = new Set(
    files
      .filter((file) => file.resourcePath.startsWith("stream/") && getExtension(file.resourcePath) === "ydr")
      .map((file) => getStem(file.resourcePath).toLowerCase()),
  );
  const componentPrefix = makeWeaponConstSlug(addonSlug);
  const components: WeaponComponentDefinition[] = [];

  if (streamModelStems.has(`${addonModelBase}_mag1`.toLowerCase())) {
    components.push({
      name: `COMPONENT_${componentPrefix}_CLIP_01`,
      model: `${addonModelBase}_mag1`,
      kind: "clip",
      clipSize: baseClipSize,
    });
  }
  if (streamModelStems.has(`${addonModelBase}_mag2`.toLowerCase())) {
    components.push({
      name: `COMPONENT_${componentPrefix}_CLIP_02`,
      model: `${addonModelBase}_mag2`,
      kind: "clip",
      clipSize: baseClipSize * 2,
    });
  }

  const suppressorBase = `w_at_${addonSlug}_supp`;
  const suppressorStem = streamModelStems.has(suppressorBase)
    ? suppressorBase
    : [...streamModelStems].find((stem) => stem.startsWith(`${suppressorBase}_`) && !stem.endsWith("_hi"));
  if (suppressorStem) {
    components.push({
      name: `COMPONENT_AT_${componentPrefix}_SUPP`,
      model: suppressorStem,
      kind: "suppressor",
    });
  }

  return components;
}

function buildGeneratedWeaponsMeta(
  profile: ReplaceWeaponProfile,
  addonWeaponName: string,
  addonModelBase: string,
  components: WeaponComponentDefinition[],
): string {
  const componentItems = components.map((component) => `        <Item>${escapeXml(component.name)}</Item>`).join("\n");
  const componentsXml = componentItems ? `\n      <Components>\n${componentItems}\n      </Components>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<CWeaponInfoBlob>
  <Infos>
    <Item type="CWeaponInfo">
      <Name>${escapeXml(addonWeaponName)}</Name>
      <Model>${escapeXml(addonModelBase)}</Model>
      <Audio>${escapeXml(profile.audio)}</Audio>
      <Slot>${escapeXml(profile.slot)}</Slot>
      <DamageType>BULLET</DamageType>
      <FireType>BULLET</FireType>
      <Group>${escapeXml(profile.group)}</Group>
      <AmmoInfo ref="${escapeXml(profile.ammoInfo)}" />
      <AimingInfo ref="${escapeXml(profile.aimingInfo)}" />
      <ClipSize value="${profile.clipSize}" />
      <AccuracySpread value="3.500000" />
      <RunAndGunAccuracy value="0.050000" />
      <RecoilAccuracyMax value="1.000000" />
      <RecoilErrorTime value="3.000000" />
      <RecoilRecoveryRate value="1.000000" />${componentsXml}
    </Item>
  </Infos>
</CWeaponInfoBlob>
`;
}

function buildGeneratedWeaponArchetypesMeta(
  addonModelBase: string,
  components: WeaponComponentDefinition[],
): string {
  const componentModels = components.map((component) => `        <Item>${escapeXml(component.model)}</Item>`).join("\n");
  const componentModelsXml = componentModels ? `\n      <ComponentModels>\n${componentModels}\n      </ComponentModels>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<CWeaponModelInfoBlob>
  <Infos>
    <Item type="CWeaponModelInfo">
      <Name>${escapeXml(addonModelBase)}</Name>
      <Model>${escapeXml(addonModelBase)}</Model>
      <TextureDictionary>${escapeXml(addonModelBase)}</TextureDictionary>
      <HiModel>${escapeXml(addonModelBase)}_hi</HiModel>
      <HiTextureDictionary>${escapeXml(addonModelBase)}+hi</HiTextureDictionary>${componentModelsXml}
    </Item>
  </Infos>
</CWeaponModelInfoBlob>
`;
}

function buildGeneratedWeaponComponentsMeta(components: WeaponComponentDefinition[]): string {
  const componentItems = components.map(buildGeneratedWeaponComponentMetaItem).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<CWeaponComponentInfoBlob>
  <Infos>
${componentItems}
  </Infos>
</CWeaponComponentInfoBlob>
`;
}

function buildGeneratedWeaponComponentMetaItem(component: WeaponComponentDefinition): string {
  if (component.kind === "clip") {
    const clipSize = component.clipSize ?? 30;
    return `    <Item type="CWeaponComponentClipInfo">
      <Name>${escapeXml(component.name)}</Name>
      <Model>${escapeXml(component.model)}</Model>
      <LocName>WCT_CLIP</LocName>
      <AttachBone>WAPClip</AttachBone>
      <ClipSize value="${clipSize}" />
    </Item>`;
  }

  return `    <Item type="CWeaponComponentInfo">
      <Name>${escapeXml(component.name)}</Name>
      <Model>${escapeXml(component.model)}</Model>
      <LocName>WCT_SUPP</LocName>
      <AttachBone>WAPSupp</AttachBone>
    </Item>`;
}

function findReplaceWeaponProfileForStem(stem: string): ReplaceWeaponProfile | null {
  const lowerStem = stem.toLowerCase();
  for (const profile of REPLACE_WEAPON_PROFILES) {
    const lowerModelBase = profile.modelBase.toLowerCase();
    if (lowerStem === lowerModelBase || lowerStem.startsWith(`${lowerModelBase}_`) || lowerStem.startsWith(`${lowerModelBase}+`)) {
      return profile;
    }
  }
  return null;
}

function getReplaceWeaponProfile(modelBase: string): ReplaceWeaponProfile | null {
  return REPLACE_WEAPON_PROFILES.find((profile) => profile.modelBase.toLowerCase() === modelBase.toLowerCase()) ?? null;
}

function sanitizeAddonWeaponSlug(rawName: string, profile: ReplaceWeaponProfile): string {
  const withoutExtension = rawName.replace(/\.(zip|rar|rpf)$/i, "");
  const cleaned = withoutExtension
    .replace(/^[a-f0-9]{4,}[-_\s]+/i, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "");
  const sanitized = sanitizeResourceName(cleaned)
    .replace(/^(weapon|addon|fivem)_+/i, "")
    .replace(/^_+|_+$/g, "");
  return sanitized || `${profile.weaponName.replace(/^WEAPON_/i, "").toLowerCase()}_addon`;
}

function makeAddonWeaponName(addonSlug: string): string {
  return `WEAPON_${makeWeaponConstSlug(addonSlug)}`;
}

function makeAddonModelBase(profile: ReplaceWeaponProfile, addonSlug: string): string {
  return `${profile.addonModelPrefix}_${addonSlug}`;
}

function makeWeaponConstSlug(addonSlug: string): string {
  return addonSlug.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "ADDON";
}

function getStem(path: string): string {
  const base = getBaseName(path);
  const ext = getExtension(base);
  if (!ext) return base;
  return base.slice(0, -(ext.length + 1));
}

function stripStreamVariantSuffix(stem: string): string {
  return stem.replace(/(?:_hi|\+hi)$/i, "");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
