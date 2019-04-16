
import ArrayBufferSlice from '../ArrayBufferSlice';
import Progressable from '../Progressable';
import { fetchData } from '../fetch';
import * as Viewer from '../viewer';
import * as Yaz0 from '../compression/Yaz0';
import * as UI from '../ui';

import { BMD, BMT, BTK, BTI, TEX1_TextureData, BRK, BCK, LoopMode } from './j3d';
import * as RARC from './rarc';
import { BMDModel, BMDModelInstance, J3DTextureHolder } from './render';
import { EFB_WIDTH, EFB_HEIGHT, GXMaterialHacks } from '../gx/gx_material';
import { TextureOverride } from '../TextureHolder';
import { readString, assertExists, hexzero, leftPad, assert } from '../util';
import { GfxDevice, GfxHostAccessPass, GfxRenderPass } from '../gfx/platform/GfxPlatform';
import { GXRenderHelperGfx } from '../gx/gx_render';
import { GfxRenderInstViewRenderer, GfxRendererLayer } from '../gfx/render/GfxRenderer';
import { BasicRenderTarget, ColorTexture, standardFullClearRenderPassDescriptor, depthClearRenderPassDescriptor, noClearRenderPassDescriptor } from '../gfx/helpers/RenderTargetHelpers';
import { RENDER_HACKS_ICON } from '../bk/scenes';
import { mat4, vec3 } from 'gl-matrix';
import { BMDObjectRenderer, SymbolMap, ObjectRenderer } from './zww_actors';
import AnimationController from '../AnimationController';

class ZTPTextureHolder extends J3DTextureHolder {
    public findTextureEntryIndex(name: string): number {
        let i: number = -1;

        i = this.searchTextureEntryIndex(name);
        if (i >= 0) return i;

        i = this.searchTextureEntryIndex(`ExtraTex/${name.toLowerCase().replace('.tga', '')}`);
        if (i >= 0) return i;

        return -1;
    }

    public addExtraTextures(device: GfxDevice, extraTextures: TEX1_TextureData[]): void {
        this.addTextures(device, extraTextures.map((texture) => {
            const name = `ExtraTex/${texture.name.toLowerCase()}`;
            return { ...texture, name };
        }));
    }
}

const materialHacks: GXMaterialHacks = {
    lightingFudge: (p) => `(0.5 * (${p.ambSource} + 0.6) * ${p.matSource})`,
};

function createScene(device: GfxDevice, renderHelper: GXRenderHelperGfx, textureHolder: J3DTextureHolder, bmdFile: RARC.RARCFile, btkFile: RARC.RARCFile, brkFile: RARC.RARCFile, bckFile: RARC.RARCFile, bmtFile: RARC.RARCFile) {
    const bmd = BMD.parse(bmdFile.buffer);
    const bmt = bmtFile ? BMT.parse(bmtFile.buffer) : null;
    textureHolder.addJ3DTextures(device, bmd, bmt);
    const bmdModel = new BMDModel(device, renderHelper, bmd, bmt);
    const scene = new BMDModelInstance(device, renderHelper, textureHolder, bmdModel, materialHacks);

    if (btkFile !== null) {
        const btk = BTK.parse(btkFile.buffer);
        scene.bindTTK1(btk.ttk1);
    }

    if (brkFile !== null) {
        const brk = BRK.parse(brkFile.buffer);
        scene.bindTRK1(brk.trk1);
    }

    if (bckFile !== null) {
        const bck = BCK.parse(bckFile.buffer);
        scene.bindANK1(bck.ank1);
    }

    return scene;
}

const enum ZTPPass {
    SKYBOX = 1 << 0,
    OPAQUE = 1 << 1,
    INDIRECT = 1 << 2,
    TRANSPARENT = 1 << 3,
}

class TwilightPrincessRenderer implements Viewer.SceneGfx {
    public renderHelper: GXRenderHelperGfx;
    public viewRenderer = new GfxRenderInstViewRenderer();
    public mainRenderTarget = new BasicRenderTarget();
    public opaqueSceneTexture = new ColorTexture();
    public modelInstances: BMDModelInstance[] = [];
    public objectRenderers: ObjectRenderer[] = [];

    constructor(device: GfxDevice, public modelCache: ModelCache, public textureHolder: J3DTextureHolder, public stageRarc: RARC.RARC) {
        this.renderHelper = new GXRenderHelperGfx(device);
    }

    public createPanels(): UI.Panel[] {
        const layers = new UI.LayerPanel();
        layers.setLayers(this.modelInstances);

        const renderHacksPanel = new UI.Panel();
        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(RENDER_HACKS_ICON, 'Render Hacks');
        const enableVertexColorsCheckbox = new UI.Checkbox('Enable Vertex Colors', true);
        enableVertexColorsCheckbox.onchanged = () => {
            for (let i = 0; i < this.modelInstances.length; i++)
                this.modelInstances[i].setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
        };
        renderHacksPanel.contents.appendChild(enableVertexColorsCheckbox.elem);
        const enableTextures = new UI.Checkbox('Enable Textures', true);
        enableTextures.onchanged = () => {
            for (let i = 0; i < this.modelInstances.length; i++)
                this.modelInstances[i].setTexturesEnabled(enableTextures.checked);
        };
        renderHacksPanel.contents.appendChild(enableTextures.elem);

        return [layers, renderHacksPanel];
    }

    public finish(device: GfxDevice): void {
        this.renderHelper.finishBuilder(device, this.viewRenderer);
    }

    private prepareToRender(hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput): void {
        viewerInput.camera.setClipPlanes(20, 500000);
        this.renderHelper.fillSceneParams(viewerInput);
        for (let i = 0; i < this.modelInstances.length; i++)
            this.modelInstances[i].prepareToRender(this.renderHelper, viewerInput);
        this.renderHelper.prepareToRender(hostAccessPass);
        for (let i = 0; i < this.objectRenderers.length; i++)
            this.objectRenderers[i].prepareToRender(this.renderHelper, viewerInput, true);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();
        this.prepareToRender(hostAccessPass, viewerInput);
        device.submitPass(hostAccessPass);

        this.viewRenderer.prepareToRender(device);

        this.mainRenderTarget.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
        this.opaqueSceneTexture.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
        this.viewRenderer.setViewport(viewerInput.viewportWidth, viewerInput.viewportHeight);

        const skyboxPassRenderer = this.mainRenderTarget.createRenderPass(device, standardFullClearRenderPassDescriptor);
        this.viewRenderer.executeOnPass(device, skyboxPassRenderer, ZTPPass.SKYBOX);
        skyboxPassRenderer.endPass(null);
        device.submitPass(skyboxPassRenderer);

        const opaquePassRenderer = this.mainRenderTarget.createRenderPass(device, depthClearRenderPassDescriptor);
        this.viewRenderer.executeOnPass(device, opaquePassRenderer, ZTPPass.OPAQUE);

        let lastPassRenderer: GfxRenderPass;
        if (this.viewRenderer.hasAnyVisible(ZTPPass.INDIRECT)) {
            opaquePassRenderer.endPass(this.opaqueSceneTexture.gfxTexture);
            device.submitPass(opaquePassRenderer);

            const textureOverride: TextureOverride = { gfxTexture: this.opaqueSceneTexture.gfxTexture, width: EFB_WIDTH, height: EFB_HEIGHT, flipY: true };
            this.textureHolder.setTextureOverride("fbtex_dummy", textureOverride);

            const indTexPassRenderer = this.mainRenderTarget.createRenderPass(device, noClearRenderPassDescriptor);
            this.viewRenderer.executeOnPass(device, indTexPassRenderer, ZTPPass.INDIRECT);
            lastPassRenderer = indTexPassRenderer;
        } else {
            lastPassRenderer = opaquePassRenderer;
        }

        this.viewRenderer.executeOnPass(device, lastPassRenderer, ZTPPass.TRANSPARENT);
        return lastPassRenderer;
    }

    public destroy(device: GfxDevice) {
        this.renderHelper.destroy(device);
        this.viewRenderer.destroy(device);
        this.textureHolder.destroy(device);
        this.mainRenderTarget.destroy(device);
        this.opaqueSceneTexture.destroy(device);
        this.modelInstances.forEach((instance) => instance.destroy(device));
    }
}

function getRoomListFromDZS(buffer: ArrayBufferSlice): number[] {
    const view = buffer.createDataView();
    const chunkCount = view.getUint32(0x00);

    const chunkOffsets = new Map<string, { offs: number, count: number }>();
    let chunkTableIdx = 0x04;
    for (let i = 0; i < chunkCount; i++) {
        const type = readString(buffer, chunkTableIdx + 0x00, 0x04);
        const count = view.getUint32(chunkTableIdx + 0x04);
        const offs = view.getUint32(chunkTableIdx + 0x08);
        chunkOffsets.set(type, { offs, count });
        chunkTableIdx += 0x0C;
    }

    const { offs: rtblOffs, count: rtblCount } = chunkOffsets.get('RTBL');
    let roomList = new Set<number>();
    for (let i = 0; i < rtblCount; i++) {
        const rtblEntryOffs = view.getUint32(rtblOffs + i * 0x04);
        const roomTableCount = view.getUint8(rtblEntryOffs + 0x00);
        if (roomTableCount === 0)
            continue;
        const roomTableOffs = view.getUint32(rtblEntryOffs + 0x04);
        roomList.add(view.getUint8(roomTableOffs + 0x00) & 0x3F);
    }
    return [... roomList.values()];
}

function bmdModelUsesTexture(model: BMDModel, textureName: string): boolean {
    return model.tex1Samplers.some((tex1Sampler) => tex1Sampler.name === textureName);
}

interface DZSChunkHeader {
    type: string;
    count: number;
    offs: number;
}

function parseDZSHeaders(buffer: ArrayBufferSlice): Map<string, DZSChunkHeader> {
    const view = buffer.createDataView();
    const chunkCount = view.getUint32(0x00);

    const chunkHeaders = new Map<string, DZSChunkHeader>();
    let chunkTableIdx = 0x04;
    for (let i = 0; i < chunkCount; i++) {
        const type = readString(buffer, chunkTableIdx + 0x00, 0x04);
        const numEntries = view.getUint32(chunkTableIdx + 0x04);
        const offs = view.getUint32(chunkTableIdx + 0x08);
        chunkHeaders.set(type, { type, count: numEntries, offs });
        chunkTableIdx += 0x0C;
    }

    return chunkHeaders;
}

interface Destroyable {
    destroy(device: GfxDevice): void;
}

class ModelCache {
    private fileProgressableCache = new Map<string, Progressable<ArrayBufferSlice>>();
    private fileDataCache = new Map<string, ArrayBufferSlice>();
    private archiveProgressableCache = new Map<string, Progressable<RARC.RARC>>();
    private archiveCache = new Map<string, RARC.RARC>();
    private modelCache = new Map<string, BMDModel>();
    public extraCache = new Map<string, Destroyable>();
    public extraModels: BMDModel[] = [];

    public waitForLoad(): Progressable<any> {
        const v: Progressable<any>[] = [... this.fileProgressableCache.values(), ... this.archiveProgressableCache.values()];
        return Progressable.all(v);
    }

    private fetchFile(path: string, abortSignal: AbortSignal): Progressable<ArrayBufferSlice> {
        assert(!this.fileProgressableCache.has(path));
        const p = fetchData(path, abortSignal);
        this.fileProgressableCache.set(path, p);
        return p;
    }

    public fetchFileData(path: string, abortSignal: AbortSignal): Progressable<ArrayBufferSlice> {
        const p = this.fileProgressableCache.get(path);
        if (p !== undefined) {
            return p.then(() => this.getFileData(path));
        } else {
            return this.fetchFile(path, abortSignal).then((data) => {
                this.fileDataCache.set(path, data);
                return data;
            });
        }
    }

    public getFileData(path: string): ArrayBufferSlice {
        return assertExists(this.fileDataCache.get(path));
    }

    public getArchive(archivePath: string): RARC.RARC {
        return assertExists(this.archiveCache.get(archivePath));
    }

    public fetchArchive(archivePath: string, abortSignal: AbortSignal): Progressable<RARC.RARC> {
        let p = this.archiveProgressableCache.get(archivePath);
        if (p === undefined) {
            p = this.fetchFile(archivePath, abortSignal).then((data) => {
                if (readString(data, 0, 0x04) === 'Yaz0')
                    return Yaz0.decompress(data);
                else
                    return data;
            }).then((data) => {
                const arc = RARC.parse(data);
                this.archiveCache.set(archivePath, arc);
                return arc;
            });
            this.archiveProgressableCache.set(archivePath, p);
        }

        return p;
    }

    public getModel(device: GfxDevice, renderer: TwilightPrincessRenderer, rarc: RARC.RARC, modelPath: string, hacks?: (bmd: BMD) => void): BMDModel {
        let p = this.modelCache.get(modelPath);

        if (p === undefined) {
            const bmdData = rarc.findFileData(modelPath);
            const bmd = BMD.parse(bmdData);
            if (hacks !== undefined)
                hacks(bmd);
            renderer.textureHolder.addJ3DTextures(device, bmd);
            p = new BMDModel(device, renderer.renderHelper, bmd);
            this.modelCache.set(modelPath, p);
        }

        return p;
    }

    public destroy(device: GfxDevice): void {
        for (const model of this.modelCache.values())
            model.destroy(device);
        for (let i = 0; i < this.extraModels.length; i++)
            this.extraModels[i].destroy(device);
        for (const x of this.extraCache.values())
            x.destroy(device);
    }
}

class TwilightPrincessSceneDesc implements Viewer.SceneDesc {
    public id: string;

    constructor(public name: string, public stageId: string, public roomNames: string[] | null = null) {
        if (roomNames !== null)
            this.id = `${this.stageId}/${this.roomNames[0]}`;
        else
            this.id = this.stageId;
    }

    private createRoomScenes(device: GfxDevice, abortSignal: AbortSignal, renderer: TwilightPrincessRenderer, rarc: RARC.RARC, rarcBasename: string): void {
        const bmdFiles = rarc.files.filter((f) => f.name.endsWith('.bmd') || f.name.endsWith('.bdl'));
        bmdFiles.forEach((bmdFile) => {
            const basename = bmdFile.name.split('.')[0];
            const btkFile = rarc.files.find((f) => f.name === `${basename}.btk`) || null;
            const brkFile = rarc.files.find((f) => f.name === `${basename}.brk`) || null;
            const bckFile = rarc.files.find((f) => f.name === `${basename}.bck`) || null;
            const bmtFile = rarc.files.find((f) => f.name === `${basename}.bmt`) || null;

            const modelInstance = createScene(device, renderer.renderHelper, renderer.textureHolder, bmdFile, btkFile, brkFile, bckFile, bmtFile);
            modelInstance.name = `${rarcBasename}/${basename}`;

            let passMask: ZTPPass = 0;
            if (basename === 'model') {
                passMask = ZTPPass.OPAQUE;
            } else if (basename === 'model1') {
                // "Water". Doesn't always mean indirect, but often can be.
                // (Snowpeak Ruins has a model1 which is not indirect)
                const usesIndirectMaterial = bmdModelUsesTexture(modelInstance.bmdModel, 'fbtex_dummy');
                passMask = usesIndirectMaterial ? ZTPPass.INDIRECT : ZTPPass.OPAQUE;
            } else if (basename === 'model2') {
                passMask = ZTPPass.TRANSPARENT;
            } else if (basename === 'model3') {
                // Window/doorways.
                passMask = ZTPPass.TRANSPARENT;
            } else if (basename === 'model4' || basename === 'model5') {
                // Light beams? No clue, stick 'em in the transparent pass.
                passMask = ZTPPass.TRANSPARENT;
            }

            modelInstance.passMask = passMask;
            renderer.modelInstances.push(modelInstance);
        });
        const dzrFile = rarc.findFileData('dzr/room.dzr');

        this.spawnObjectsFromDZR(device, abortSignal, renderer, dzrFile, mat4.create());
    }


    private spawnObjectsFromTGOBLayer(device: GfxDevice, abortSignal: AbortSignal, renderer: TwilightPrincessRenderer, buffer: ArrayBufferSlice, tgobHeader: DZSChunkHeader | undefined, worldModelMatrix: mat4): void {
        if (tgobHeader === undefined)
            return;

        const view = buffer.createDataView();

        let actrTableIdx = tgobHeader.offs;
        for (let i = 0; i < tgobHeader.count; i++) {
            const name = readString(buffer, actrTableIdx + 0x00, 0x08, true);
            const parameters = view.getUint32(actrTableIdx + 0x08, false);
            const posX = view.getFloat32(actrTableIdx + 0x0C);
            const posY = view.getFloat32(actrTableIdx + 0x10);
            const posZ = view.getFloat32(actrTableIdx + 0x14);
            const rotY = view.getInt16(actrTableIdx + 0x1A) / 0x7FFF * Math.PI;

            const localModelMatrix = mat4.create();
            mat4.rotateY(localModelMatrix, localModelMatrix, rotY);
            localModelMatrix[12] += posX;
            localModelMatrix[13] += posY;
            localModelMatrix[14] += posZ;

            this.spawnObjectsForActor(device, abortSignal, renderer, name, parameters, localModelMatrix, worldModelMatrix);

            actrTableIdx += 0x20;
        }
    }

    private spawnObjectsFromACTRLayer(device: GfxDevice, abortSignal: AbortSignal, renderer: TwilightPrincessRenderer, buffer: ArrayBufferSlice, actrHeader: DZSChunkHeader | undefined, worldModelMatrix: mat4): void {
        if (actrHeader === undefined)
            return;

        const view = buffer.createDataView();

        let actrTableIdx = actrHeader.offs;
        for (let i = 0; i < actrHeader.count; i++) {
            const name = readString(buffer, actrTableIdx + 0x00, 0x08, true);
            const parameters = view.getUint32(actrTableIdx + 0x08, false);
            const posX = view.getFloat32(actrTableIdx + 0x0C);
            const posY = view.getFloat32(actrTableIdx + 0x10);
            const posZ = view.getFloat32(actrTableIdx + 0x14);
            // const rotX = view.getInt16(actrTableIdx + 0x18) / 0x7FFF;
            const rotY = view.getInt16(actrTableIdx + 0x1A) / 0x7FFF * Math.PI;
            const flag = view.getUint16(actrTableIdx + 0x1C);
            const enemyNum = view.getUint16(actrTableIdx + 0x1E);

            const localModelMatrix = mat4.create();
            mat4.rotateY(localModelMatrix, localModelMatrix, rotY);
            localModelMatrix[12] += posX;
            localModelMatrix[13] += posY;
            localModelMatrix[14] += posZ;

            this.spawnObjectsForActor(device, abortSignal, renderer, name, parameters, localModelMatrix, worldModelMatrix);

            actrTableIdx += 0x20;
        }
    }

    private spawnObjectsFromDZR(device: GfxDevice, abortSignal: AbortSignal, renderer: TwilightPrincessRenderer, buffer: ArrayBufferSlice, modelMatrix: mat4): void {
        const chunkHeaders = parseDZSHeaders(buffer);

        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACTR'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT0'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT1'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT2'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT3'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT4'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT5'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT6'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT7'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT8'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACT9'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACTA'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('ACTB'), modelMatrix);
        this.spawnObjectsFromTGOBLayer(device, abortSignal, renderer, buffer, chunkHeaders.get('TGOB'), modelMatrix);
    }

    private spawnObjectsForActor(device: GfxDevice, abortSignal: AbortSignal, renderer: TwilightPrincessRenderer, name: string, parameters: number, localModelMatrix: mat4, worldModelMatrix: mat4): void {
        const modelCache = renderer.modelCache;

        function fetchArchive(objArcName: string): Progressable<RARC.RARC> {
            return renderer.modelCache.fetchArchive(`j3d/ztp/Object/${objArcName}`, abortSignal);
        }

        function buildChildModel(rarc: RARC.RARC, modelPath: string): BMDObjectRenderer {
            const model = modelCache.getModel(device, renderer, rarc, modelPath);
            const modelInstance = new BMDModelInstance(device, renderer.renderHelper, renderer.textureHolder, model);
            modelInstance.name = name;
            modelInstance.setSortKeyLayer(GfxRendererLayer.OPAQUE + 1);
            return new BMDObjectRenderer(modelInstance);
        }

        function setModelMatrix(m: mat4): void {
            mat4.mul(m, worldModelMatrix, localModelMatrix);
        }

        function buildModel(rarc: RARC.RARC, modelPath: string): BMDObjectRenderer {
            const objectRenderer = buildChildModel(rarc, modelPath);
            setModelMatrix(objectRenderer.modelMatrix);
            renderer.objectRenderers.push(objectRenderer);
            return objectRenderer;
        }

        function buildChildModelBMT(rarc: RARC.RARC, modelPath: string, bmtPath: string): BMDObjectRenderer {
            const bmd = BMD.parse(rarc.findFileData(modelPath));
            const bmt = BMT.parse(rarc.findFileData(bmtPath));
            renderer.textureHolder.addJ3DTextures(device, bmd, bmt);
            const model = new BMDModel(device, renderer.renderHelper, bmd, bmt);
            modelCache.extraModels.push(model);
            const modelInstance = new BMDModelInstance(device, renderer.renderHelper, renderer.textureHolder, model);
            modelInstance.name = name;
            modelInstance.setSortKeyLayer(GfxRendererLayer.OPAQUE + 1);
            return new BMDObjectRenderer(modelInstance);
        }

        function buildModelBMT(rarc: RARC.RARC, modelPath: string, bmtPath: string): BMDObjectRenderer {
            const objectRenderer = buildChildModelBMT(rarc, modelPath, bmtPath);
            setModelMatrix(objectRenderer.modelMatrix);
            renderer.objectRenderers.push(objectRenderer);
            return objectRenderer;
        }

        function parseBCK(rarc: RARC.RARC, path: string) { const g = BCK.parse(rarc.findFileData(path)).ank1; g.loopMode = LoopMode.REPEAT; return g; }
        function parseBRK(rarc: RARC.RARC, path: string) { return BRK.parse(rarc.findFileData(path)).trk1; }
        function parseBTK(rarc: RARC.RARC, path: string) { return BTK.parse(rarc.findFileData(path)).ttk1; }
        function animFrame(frame: number): AnimationController { const a = new AnimationController(); a.setTimeInFrames(frame); return a; }

        // Tremendous special thanks to LordNed, Sage-of-Mirrors & LugoLunatic for their work on actor mapping
        // Heavily based on https://github.com/LordNed/Winditor/blob/master/Editor/resources/ActorDatabase.json
        
        //if (name === 'Cow') fetchArchive(`Cow.arc`).then((rarc) => buildModel(rarc, `bmdr/cow.bmd`));
        if (name === 'Pumpkin') fetchArchive(`pumpkin.arc`).then((rarc) => buildModel(rarc, `bmdr/pumpkin.bmd`));
        else
            console.warn(`Unknown object: ${name}`);
    }

    public createScene(device: GfxDevice, abortSignal: AbortSignal): Progressable<Viewer.SceneGfx> {
        const basePath = `j3d/ztp/${this.stageId}`;
        const textureHolder = new ZTPTextureHolder();
        const modelCache = new ModelCache();

        return this.fetchRarc(`${basePath}/STG_00.arc`).then((stageRarc: RARC.RARC) => {
            // Load stage shared textures.
            const texcFolder = stageRarc.findDir(`texc`);
            const extraTextureFiles = texcFolder !== null ? texcFolder.files : [];
            const extraTextures = extraTextureFiles.map((file) => {
                const name = file.name.split('.')[0];
                return BTI.parse(file.buffer, name).texture;
            });

            textureHolder.addExtraTextures(device, extraTextures);

            const renderer = new TwilightPrincessRenderer(device, modelCache, textureHolder, stageRarc);

            [`vrbox_sora`, `vrbox_kasumim`].forEach((basename) => {
                const bmdFile = stageRarc.findFile(`bmdp/${basename}.bmd`);
                if (!bmdFile)
                    return null;
                const btkFile = stageRarc.findFile(`btk/${basename}.btk`);
                const brkFile = stageRarc.findFile(`brk/${basename}.brk`);
                const bckFile = stageRarc.findFile(`bck/${basename}.bck`);
                const scene = createScene(device, renderer.renderHelper, textureHolder, bmdFile, btkFile, brkFile, bckFile, null);
                scene.name = `stage/${basename}`;
                scene.setIsSkybox(true);
                renderer.modelInstances.push(scene);
            });

            // Pull out the dzs, get the scene definition.
            const dzsBuffer = stageRarc.findFile(`dzs/stage.dzs`).buffer;

            let roomNames: string[];

            if (this.roomNames !== null) {
                roomNames = this.roomNames;
            } else {
                // TODO(jstpierre): This room list isn't quite right. How does the original game work?
                const roomList = getRoomListFromDZS(dzsBuffer);
                roomNames = roomList.map((i) => `R${leftPad(''+i, 2)}_00`);
            }

            return Progressable.all(roomNames.map((roomName) => this.fetchRarc(`${basePath}/${roomName}.arc`))).then((roomRarcs: (RARC.RARC | null)[]) => {
                roomRarcs.forEach((rarc: RARC.RARC | null, i) => {
                    if (rarc === null) return;
                    this.createRoomScenes(device, abortSignal, renderer, rarc, roomNames[i]);
                });

                renderer.finish(device);
                return renderer;
            });
        });
    }

    private fetchRarc(path: string): Progressable<RARC.RARC | null> {
        return fetchData(path).then((buffer: ArrayBufferSlice) => {
            if (buffer.byteLength === 0) return null;
            return Yaz0.decompress(buffer).then((buffer: ArrayBufferSlice) => RARC.parse(buffer));
        });
    }
}

const id = "ztp";
const name = "The Legend of Zelda: Twilight Princess";

// Special thanks to Jawchewa and SkrillerArt for helping me with naming the maps.
const sceneDescs = [
    "Ordon Village",
    new TwilightPrincessSceneDesc("Ordon Village", "F_SP103", ["R00_00"]),
    new TwilightPrincessSceneDesc("Outside Link's House", "F_SP103", ["R01_00"]),
    new TwilightPrincessSceneDesc("Ordon Ranch", "F_SP00"),

    "Ordon Village Indoors",
    new TwilightPrincessSceneDesc("Mayor's House", "R_SP01", ["R00_00"]),
    new TwilightPrincessSceneDesc("Sera's Sundries", "R_SP01", ["R01_00"]),
    new TwilightPrincessSceneDesc("Talo and Malo's House", "R_SP01", ["R02_00"]),
    new TwilightPrincessSceneDesc("Link's House", "R_SP01", ["R04_00", "R07_00"]),
    new TwilightPrincessSceneDesc("Rusl's House", "R_SP01", ["R05_00"]),

    "Overworld Maps",
    new TwilightPrincessSceneDesc("Hyrule Field Map 1", "F_SP102"),
    new TwilightPrincessSceneDesc("Hyrule Field Map 2", "F_SP121"),
    new TwilightPrincessSceneDesc("Hyrule Field Map 3", "F_SP122"),
    new TwilightPrincessSceneDesc("Lake Hylia", "F_SP123"),

    new TwilightPrincessSceneDesc("Ordon Woods", "F_SP104"),
    new TwilightPrincessSceneDesc("Faron Woods", "F_SP108"),
    new TwilightPrincessSceneDesc("Kakariko Village", "F_SP109"),
    new TwilightPrincessSceneDesc("Death Mountain Trail", "F_SP110"),
    new TwilightPrincessSceneDesc("Kakariko Graveyard", "F_SP111"),
    new TwilightPrincessSceneDesc("Rapids Ride", "F_SP112"),
    new TwilightPrincessSceneDesc("Zora's Domain", "F_SP113"),
    new TwilightPrincessSceneDesc("Snowpeak Mountain", "F_SP114"),
    new TwilightPrincessSceneDesc("Lanayru's Spring", "F_SP115"),
    new TwilightPrincessSceneDesc("Castle Town", "F_SP116"),
    new TwilightPrincessSceneDesc("Sacred Grove", "F_SP117"),
    new TwilightPrincessSceneDesc("Gerudo Desert Bulblin Base", "F_SP118"),
    new TwilightPrincessSceneDesc("Gerudo Desert", "F_SP124"),
    new TwilightPrincessSceneDesc("Arbiter's Grounds Mirror Chamber", "F_SP125"),
    new TwilightPrincessSceneDesc("Zora's River", "F_SP126"),
    new TwilightPrincessSceneDesc("Fishing Pond", "F_SP127"),
    new TwilightPrincessSceneDesc("Hidden Village", "F_SP128"),
    new TwilightPrincessSceneDesc("Wolf Howling Cutscene Map", "F_SP200"),

    "Dungeons",
    new TwilightPrincessSceneDesc("Forest Temple", "D_MN05"),
    new TwilightPrincessSceneDesc("Forest Temple Boss Arena", "D_MN05A"),
    new TwilightPrincessSceneDesc("Forest Temple Mini-Boss Arena", "D_MN05B"),

    new TwilightPrincessSceneDesc("Goron Mines", "D_MN04"),
    new TwilightPrincessSceneDesc("Goron Mines Boss Arena", "D_MN04A"),
    new TwilightPrincessSceneDesc("Goron Mines Mini-Boss Arena", "D_MN04B"),

    new TwilightPrincessSceneDesc("Lakebed Temple", "D_MN01"),
    new TwilightPrincessSceneDesc("Lakebed Temple Boss Arena", "D_MN01A"),
    new TwilightPrincessSceneDesc("Lakebed Temple Mini-Boss Arena", "D_MN01B"),

    new TwilightPrincessSceneDesc("Arbiter's Grounds", "D_MN10"),
    new TwilightPrincessSceneDesc("Arbiter's Grounds Boss Arena", "D_MN10A"),
    new TwilightPrincessSceneDesc("Arbiter's Grounds Mini-Boss Arena", "D_MN10B"),

    new TwilightPrincessSceneDesc("Snowpeak Ruins", "D_MN11"),
    new TwilightPrincessSceneDesc("Snowpeak Ruins Boss Arena", "D_MN11A"),
    new TwilightPrincessSceneDesc("Snowpeak Ruins Mini-Boss Arena", "D_MN11B"),

    new TwilightPrincessSceneDesc("Temple of Time", "D_MN06"),
    new TwilightPrincessSceneDesc("Temple of Time Boss Arena", "D_MN06A"),
    new TwilightPrincessSceneDesc("Temple of Time Mini-Boss Arena", "D_MN06B"),

    new TwilightPrincessSceneDesc("City in the Sky", "D_MN07"),
    new TwilightPrincessSceneDesc("City in the Sky Boss Arena", "D_MN07A"),
    new TwilightPrincessSceneDesc("City in the Sky Mini-Boss Arena", "D_MN07B"),

    new TwilightPrincessSceneDesc("Palace of Twilight", "D_MN08"),
    new TwilightPrincessSceneDesc("Palace of Twilight Boss Arena 1", "D_MN08A"),
    new TwilightPrincessSceneDesc("Palace of Twilight Mini-Boss Arena 1", "D_MN08B"),
    new TwilightPrincessSceneDesc("Palace of Twilight Mini-Boss Arena 2", "D_MN08C"),
    new TwilightPrincessSceneDesc("Palace of Twilight Boss Rush Arena", "D_MN08D"),

    new TwilightPrincessSceneDesc("Hyrule Castle", "D_MN09"),
    new TwilightPrincessSceneDesc("Hyrule Castle Boss Arena", "D_MN09A"),
    new TwilightPrincessSceneDesc("Final Boss Arena (On Horseback)", "D_MN09B"),
    new TwilightPrincessSceneDesc("Final Boss Arena", "D_MN09C"),

    "Mini-Dungeons and Grottos",
    new TwilightPrincessSceneDesc("Ice Cavern", "D_SB00"),
    new TwilightPrincessSceneDesc("Cave Of Ordeals", "D_SB01"),
    new TwilightPrincessSceneDesc("Kakariko Lantern Cavern", "D_SB02"),
    new TwilightPrincessSceneDesc("Lake Hylia Lantern Cavern", "D_SB03"),
    new TwilightPrincessSceneDesc("Goron Mines Lantern Cavern", "D_SB04"),
    new TwilightPrincessSceneDesc("Faron Woods Lantern Cavern", "D_SB10"),
    new TwilightPrincessSceneDesc("Faron Woods Cave 1", "D_SB05"),
    new TwilightPrincessSceneDesc("Faron Woods Cave 2", "D_SB06"),
    new TwilightPrincessSceneDesc("Snow Cave 1", "D_SB07"),
    new TwilightPrincessSceneDesc("Snow Cave 2", "D_SB08"),
    new TwilightPrincessSceneDesc("Water Cave", "D_SB09"),

    "Houses / Indoors",
    new TwilightPrincessSceneDesc("Hyrule Castle Wolf Escape", "R_SP107"),
    new TwilightPrincessSceneDesc("Caro's House", "R_SP108"),
    new TwilightPrincessSceneDesc("Kakariko Village Houses", "R_SP109"),
    new TwilightPrincessSceneDesc("Goron Mines Entrance", "R_SP110"),
    new TwilightPrincessSceneDesc("Telma's Bar + Castle Town Sewers", "R_SP116"),
    new TwilightPrincessSceneDesc("Fishing Hole Interior", "R_SP127"),
    new TwilightPrincessSceneDesc("Impaz's House", "R_SP128"),
    new TwilightPrincessSceneDesc("Castle Town Houses", "R_SP160"),
    new TwilightPrincessSceneDesc("Star Tent", "R_SP161"),
    new TwilightPrincessSceneDesc("Kakariko Sanctuary", "R_SP209"),
    new TwilightPrincessSceneDesc("Cutscene: Light Arrow Area", "R_SP300"),
    new TwilightPrincessSceneDesc("Cutscene: Hyrule Castle Throne Room", "R_SP301"),    
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
