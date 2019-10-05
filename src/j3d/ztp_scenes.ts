
import ArrayBufferSlice from '../ArrayBufferSlice';
import { DataFetcher, DataFetcherFlags } from '../DataFetcher';
import * as Viewer from '../viewer';
import * as Yaz0 from '../compression/Yaz0';
import * as UI from '../ui';

import { BMD, BMT, BTK, BTI, BRK, BCK, LoopMode, BTI_Texture } from './j3d';
import * as RARC from './rarc';
import { BMDModel, BMDModelInstance, BTIData } from './render';
import { EFB_WIDTH, EFB_HEIGHT, GXMaterialHacks } from '../gx/gx_material';
import { readString, assertExists, leftPad, assert } from '../util';
import { GfxDevice, GfxHostAccessPass, GfxRenderPass } from '../gfx/platform/GfxPlatform';
import { GXRenderHelperGfx, fillSceneParamsDataOnTemplate } from '../gx/gx_render';
import { GfxRendererLayer } from '../gfx/render/GfxRenderer';
import { BasicRenderTarget, ColorTexture, standardFullClearRenderPassDescriptor, depthClearRenderPassDescriptor, noClearRenderPassDescriptor } from '../gfx/helpers/RenderTargetHelpers';
import { mat4 } from 'gl-matrix';
import { BMDObjectRenderer, ObjectRenderer } from './ztp_actors';
import { TextureMapping } from '../TextureHolder';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache';
import { SceneContext } from '../SceneBase';

class ZTPExtraTextures {
    public extraTextures: BTIData[] = [];

    public addBTI(device: GfxDevice, btiTexture: BTI_Texture): void {
        this.extraTextures.push(new BTIData(device, btiTexture));
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.extraTextures.length; i++)
            this.extraTextures[i].destroy(device);
    }

    public fillTextureMapping = (m: TextureMapping, samplerName: string): boolean => {
        // Look through for extra textures.
        const searchName = samplerName.toLowerCase().replace('.tga', '');
        const extraTexture = this.extraTextures.find((extraTex) => extraTex.btiTexture.name === searchName);
        if (extraTexture !== undefined)
            return extraTexture.fillTextureMapping(m);

        return false;
    };
}

const materialHacks: GXMaterialHacks = {
    lightingFudge: (p) => `(0.5 * (${p.ambSource} + 0.6) * ${p.matSource})`,
};

function createModelInstance(device: GfxDevice, cache: GfxRenderCache, extraTextures: ZTPExtraTextures, bmdFile: RARC.RARCFile, btkFile: RARC.RARCFile, brkFile: RARC.RARCFile, bckFile: RARC.RARCFile, bmtFile: RARC.RARCFile) {
    const bmd = BMD.parse(bmdFile.buffer);
    const bmt = bmtFile ? BMT.parse(bmtFile.buffer) : null;
    const bmdModel = new BMDModel(device, cache, bmd, bmt);
    const modelInstance = new BMDModelInstance(bmdModel, materialHacks);

    for (let i = 0; i < bmdModel.tex1Data.tex1.samplers.length; i++) {
        // Look for any unbound textures and set them.
        const sampler = bmdModel.tex1Data.tex1.samplers[i];
        const m = modelInstance.materialInstanceState.textureMappings[i];
        if (m.gfxTexture === null)
            extraTextures.fillTextureMapping(m, sampler.name);
    }

    if (btkFile !== null) {
        const btk = BTK.parse(btkFile.buffer);
        modelInstance.bindTTK1(btk.ttk1);
    }

    if (brkFile !== null) {
        const brk = BRK.parse(brkFile.buffer);
        modelInstance.bindTRK1(brk.trk1);
    }

    if (bckFile !== null) {
        const bck = BCK.parse(bckFile.buffer);
        modelInstance.bindANK1(bck.ank1);
    }

    return modelInstance;
}

const enum ZTPPass {
    SKYBOX = 1 << 0,
    OPAQUE = 1 << 1,
    INDIRECT = 1 << 2,
    TRANSPARENT = 1 << 3,
}

class TwilightPrincessRenderer implements Viewer.SceneGfx {
    public renderHelper: GXRenderHelperGfx;
    public mainRenderTarget = new BasicRenderTarget();
    public opaqueSceneTexture = new ColorTexture();
    public modelInstances: BMDModelInstance[] = [];
    public objectRenderers: ObjectRenderer[] = [];
    public objectsVisible: boolean = true;

    constructor(device: GfxDevice, public modelCache: ModelCache, public extraTextures: ZTPExtraTextures, public stageRarc: RARC.RARC) {
        this.renderHelper = new GXRenderHelperGfx(device);
    }

    public createPanels(): UI.Panel[] {
        const layers = new UI.LayerPanel();
        layers.setLayers(this.modelInstances);

        const renderHacksPanel = new UI.Panel();
        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');
        const enableVertexColorsCheckbox = new UI.Checkbox('Enable Vertex Colors', true);
        enableVertexColorsCheckbox.onchanged = () => {
            for (let i = 0; i < this.modelInstances.length; i++)
                this.modelInstances[i].setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
            for (let i = 0; i < this.objectRenderers.length; i++)
                this.objectRenderers[i].setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
        };
        renderHacksPanel.contents.appendChild(enableVertexColorsCheckbox.elem);
        const enableTextures = new UI.Checkbox('Enable Textures', true);
        enableTextures.onchanged = () => {
            for (let i = 0; i < this.modelInstances.length; i++)
                this.modelInstances[i].setTexturesEnabled(enableTextures.checked);
            for (let i = 0; i < this.objectRenderers.length; i++)
                this.objectRenderers[i].setTexturesEnabled(enableTextures.checked);
        };
        renderHacksPanel.contents.appendChild(enableTextures.elem);
        const enableObjects = new UI.Checkbox('Enable Objects', true);
        enableObjects.onchanged = () => {
            this.objectsVisible = enableObjects.checked;
        };
        renderHacksPanel.contents.appendChild(enableObjects.elem);

        return [layers, renderHacksPanel];
    }

    private prepareToRender(device: GfxDevice, hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        fillSceneParamsDataOnTemplate(template, viewerInput);
        for (let i = 0; i < this.modelInstances.length; i++)
            this.modelInstances[i].prepareToRender(device, this.renderHelper.renderInstManager, viewerInput);
        for (let i = 0; i < this.objectRenderers.length; i++)
            this.objectRenderers[i].prepareToRender(device, this.renderHelper.renderInstManager, viewerInput, this.objectsVisible);
        this.renderHelper.prepareToRender(device, hostAccessPass);
        this.renderHelper.renderInstManager.popTemplateRenderInst();
    }

    private setIndirectTextureOverride(): void {
        for (let i = 0; i < this.modelInstances.length; i++) {
            const m = this.modelInstances[i].getTextureMappingReference('fbtex_dummy');
            if (m !== null) {
                m.gfxTexture = this.opaqueSceneTexture.gfxTexture;
                m.width = EFB_WIDTH;
                m.height = EFB_HEIGHT;
                m.flipY = true;
            }
        }
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const renderInstManager = this.renderHelper.renderInstManager;

        this.setIndirectTextureOverride();

        const hostAccessPass = device.createHostAccessPass();
        this.prepareToRender(device, hostAccessPass, viewerInput);
        device.submitPass(hostAccessPass);

        this.mainRenderTarget.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
        this.opaqueSceneTexture.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);

        const skyboxPassRenderer = this.mainRenderTarget.createRenderPass(device, standardFullClearRenderPassDescriptor);
        skyboxPassRenderer.setViewport(viewerInput.viewportWidth, viewerInput.viewportHeight);
        renderInstManager.setVisibleByFilterKeyExact(ZTPPass.SKYBOX);
        renderInstManager.drawOnPassRenderer(device, skyboxPassRenderer);
        skyboxPassRenderer.endPass(null);
        device.submitPass(skyboxPassRenderer);

        const opaquePassRenderer = this.mainRenderTarget.createRenderPass(device, depthClearRenderPassDescriptor);
        opaquePassRenderer.setViewport(viewerInput.viewportWidth, viewerInput.viewportHeight);
        renderInstManager.setVisibleByFilterKeyExact(ZTPPass.OPAQUE);
        renderInstManager.drawOnPassRenderer(device, opaquePassRenderer);

        let lastPassRenderer: GfxRenderPass;
        renderInstManager.setVisibleByFilterKeyExact(ZTPPass.INDIRECT);
        if (renderInstManager.hasAnyVisible()) {
            opaquePassRenderer.endPass(this.opaqueSceneTexture.gfxTexture);
            device.submitPass(opaquePassRenderer);

            const indTexPassRenderer = this.mainRenderTarget.createRenderPass(device, noClearRenderPassDescriptor);
            indTexPassRenderer.setViewport(viewerInput.viewportWidth, viewerInput.viewportHeight);
            renderInstManager.drawOnPassRenderer(device, indTexPassRenderer);
            lastPassRenderer = indTexPassRenderer;
        } else {
            lastPassRenderer = opaquePassRenderer;
        }

        renderInstManager.setVisibleByFilterKeyExact(ZTPPass.TRANSPARENT);
        renderInstManager.drawOnPassRenderer(device, lastPassRenderer);
        renderInstManager.resetRenderInsts();
        return lastPassRenderer;
    }

    public destroy(device: GfxDevice) {
        this.renderHelper.destroy(device);
        this.extraTextures.destroy(device);
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
    return model.bmd.tex1.samplers.some((sampler) => sampler.name === textureName);
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
    private fileProgressableCache = new Map<string, Promise<ArrayBufferSlice>>();
    private fileDataCache = new Map<string, ArrayBufferSlice>();
    private archiveProgressableCache = new Map<string, Promise<RARC.RARC>>();
    private archiveCache = new Map<string, RARC.RARC>();
    private modelCache = new Map<string, BMDModel>();
    public extraCache = new Map<string, Destroyable>();
    public extraModels: BMDModel[] = [];

    constructor(private dataFetcher: DataFetcher) {
    }

    public waitForLoad(): Promise<any> {
        const v: Promise<any>[] = [... this.fileProgressableCache.values(), ... this.archiveProgressableCache.values()];
        return Promise.all(v);
    }

    private fetchFile(path: string): Promise<ArrayBufferSlice> {
        assert(!this.fileProgressableCache.has(path));
        const p = this.dataFetcher.fetchData(path);
        this.fileProgressableCache.set(path, p);
        return p;
    }

    public fetchFileData(path: string): Promise<ArrayBufferSlice> {
        const p = this.fileProgressableCache.get(path);
        if (p !== undefined) {
            return p.then(() => this.getFileData(path));
        } else {
            return this.fetchFile(path).then((data) => {
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

    public fetchArchive(archivePath: string): Promise<RARC.RARC> {
        let p = this.archiveProgressableCache.get(archivePath);
        if (p === undefined) {
            p = this.fetchFile(archivePath).then((data) => {
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

    public getModel(device: GfxDevice, cache: GfxRenderCache, rarc: RARC.RARC, modelPath: string, hacks?: (bmd: BMD) => void): BMDModel {
        let p = this.modelCache.get(modelPath);

        if (p === undefined) {
            const bmdData = rarc.findFileData(modelPath);
            const bmd = BMD.parse(bmdData);
            if (hacks !== undefined)
                hacks(bmd);
            p = new BMDModel(device, cache, bmd);
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
const pathBase = `j3d/ztp`;

class TwilightPrincessSceneDesc implements Viewer.SceneDesc {
    public id: string;

    constructor(public name: string, public stageId: string, public roomNames: string[] | null = null) {
        if (roomNames !== null)
            this.id = `${this.stageId}/${this.roomNames[0]}`;
        else
            this.id = this.stageId;
    }

    private createRoomScenes(device: GfxDevice, renderer: TwilightPrincessRenderer, rarc: RARC.RARC, rarcBasename: string): void {
        const bmdFiles = rarc.files.filter((f) => f.name.endsWith('.bmd') || f.name.endsWith('.bdl'));
        bmdFiles.forEach((bmdFile) => {
            const basename = bmdFile.name.split('.')[0];
            const btkFile = rarc.files.find((f) => f.name === `${basename}.btk`) || null;
            const brkFile = rarc.files.find((f) => f.name === `${basename}.brk`) || null;
            const bckFile = rarc.files.find((f) => f.name === `${basename}.bck`) || null;
            const bmtFile = rarc.files.find((f) => f.name === `${basename}.bmt`) || null;

            const cache = renderer.renderHelper.renderInstManager.gfxRenderCache;
            const modelInstance = createModelInstance(device, cache, renderer.extraTextures, bmdFile, btkFile, brkFile, bckFile, bmtFile);
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

        this.spawnObjectsFromDZR(device, renderer, dzrFile, mat4.create());
    }

    private spawnObjectsFromTGOBLayer(device: GfxDevice, renderer: TwilightPrincessRenderer, buffer: ArrayBufferSlice, tgobHeader: DZSChunkHeader | undefined, worldModelMatrix: mat4): void {
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

            this.spawnObjectsForActor(device, renderer, name, parameters, localModelMatrix, worldModelMatrix);

            actrTableIdx += 0x20;
        }
    }

    private spawnObjectsFromACTRLayer(device: GfxDevice, renderer: TwilightPrincessRenderer, buffer: ArrayBufferSlice, actrHeader: DZSChunkHeader | undefined, worldModelMatrix: mat4): void {
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

            this.spawnObjectsForActor(device, renderer, name, parameters, localModelMatrix, worldModelMatrix);

            actrTableIdx += 0x20;
        }
    }

    private spawnObjectsFromDZR(device: GfxDevice, renderer: TwilightPrincessRenderer, buffer: ArrayBufferSlice, modelMatrix: mat4): void {
        const chunkHeaders = parseDZSHeaders(buffer);

        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACTR'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT0'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT1'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT2'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT3'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT4'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT5'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT6'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT7'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT8'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACT9'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACTA'), modelMatrix);
        this.spawnObjectsFromACTRLayer(device, renderer, buffer, chunkHeaders.get('ACTB'), modelMatrix);
        this.spawnObjectsFromTGOBLayer(device, renderer, buffer, chunkHeaders.get('TGOB'), modelMatrix);
    }

    private spawnObjectsForActor(device: GfxDevice, renderer: TwilightPrincessRenderer, name: string, parameters: number, localModelMatrix: mat4, worldModelMatrix: mat4): void {
        const modelCache = renderer.modelCache;
        const cache = renderer.renderHelper.renderInstManager.gfxRenderCache;

        function fetchArchive(objArcName: string): Promise<RARC.RARC> {
            return renderer.modelCache.fetchArchive(`${pathBase}/res/Object/${objArcName}`);
        }

        function buildChildModel(rarc: RARC.RARC, modelPath: string): BMDObjectRenderer {
            const model = modelCache.getModel(device, cache, rarc, modelPath);
            const modelInstance = new BMDModelInstance(model);
            modelInstance.name = name;
            modelInstance.passMask = ZTPPass.OPAQUE;
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

        function parseBCK(rarc: RARC.RARC, path: string) { const g = BCK.parse(rarc.findFileData(path)).ank1; g.loopMode = LoopMode.REPEAT; return g; }

        //Goat
        if (name === 'Cow') fetchArchive(`Cow.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/cow.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/cow_wait_a.bck`));
        });
        //Epona
        if (name === 'Horse') fetchArchive(`Horse.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/hs.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/hs_wait_01.bck`));
        });
        //Ordon Village Cat
        else if (name === 'Npc_ne') fetchArchive(`Npc_ne.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/ne.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/ne_wait.bck`));
        });
        //Monkey
        else if (name === 'Npc_ks') fetchArchive(`Npc_ks.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/saru.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/saru_wait_a.bck`));
        });
        //Cuccoo
        else if (name === 'Ni') fetchArchive(`Ni.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/ni.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/ni_wait1.bck`));
        });
        //Spirits
        //Hero's Shade - Golden Wolf
        else if (name === 'GWolf') fetchArchive(`GWolf.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/gw.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/wl_waitsit.bck`));
        });
        //Ordona
        else if (name === 'FSeirei') fetchArchive(`Seirei.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmde/seia.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/seia_wait_a.bck`));
        });
        //Children
        //Malo
        else if (name === 'Maro') fetchArchive(`Maro.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/maro.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/maro_wait_a.bck`));
        });
        //Collin
        else if (name === 'Kolin') fetchArchive(`Kolin.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/kolin.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/kolin_wait_a.bck`));
        });
        //Talo
        else if (name === 'Taro') fetchArchive(`Taro.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/taro.bmd`);
            fetchArchive(`Taro0.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/taro_wait_a.bck`));
            });
        });
        //Beth
        else if (name === 'Besu') fetchArchive(`Besu.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/besu.bmd`);
            fetchArchive(`Besu0.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/besu_wait_a.bck`));
            });
        });
        //Ordon NPCs
        //Ilia
        else if (name === 'Yelia') fetchArchive(`Yelia.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/yelia.bmd`);
            fetchArchive(`Yelia0.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/yelia_wait_a.bck`));
            });
        });
        //Fado
        else if (name === 'Aru') fetchArchive(`Aru.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/aru.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/aru_wait_a.bck`));
        });
        //Hanch
        else if (name === 'Hanjo') fetchArchive(`Hanjo.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/hanjo.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/hanjo_wait_a.bck`));
        });
        //Jaggle
        else if (name === 'Jagar') fetchArchive(`Jagar.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/jagar.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/jagar_wait_a.bck`));
        });
        //Rusl
        else if (name === 'Moi') fetchArchive(`Moi.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/moi.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/moi_wait_a.bck`));
        });
        //Mayor Bo
        else if (name === 'Bou') fetchArchive(`Bou.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/bou.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/bou_wait_a.bck`));
        });
        //Pergie
        else if (name === 'Kyury') fetchArchive(`Kyury.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/kyury.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/kyury_wait_a.bck`));
        });
        //Sera
        else if (name === 'Seira') fetchArchive(`Sera.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/sera.bmd`);
            fetchArchive(`Seira.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/sera_wait_a.bck`));
            });
        });
        //Uli
        else if (name === 'Uri') fetchArchive(`Uri.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/uri.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/uri_wait_a.bck`));
        });
        //Faron Woods NPCs
        //Rusk R
        else if (name === 'MoiR') fetchArchive(`MoiR.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/moir.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/moir_wait_a.bck`));
        });
        //Coro
        else if (name === 'Kkri') fetchArchive(`Kkri.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/kkri.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/kkri_waitsit_a.bck`));
        });
        //Trill
        else if (name === 'MYNA') fetchArchive(`NPC_myna.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/myna.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/myna_wait_a.bck`));
        });
        //Kakariko NPCs
        //Renaldo
        else if (name === 'Len') fetchArchive(`Len.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/len.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/len_wait_a.bck`));
        });
        //Luda
        else if (name === 'Lud') fetchArchive(`Lud.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/lud.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/lud_wait_a.bck`));
        });
        //Barns
        else if (name === 'Bans') fetchArchive(`Bans.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmde/bans.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/bans_wait_a.bck`));
        });
        //Shad
        else if (name === 'Shad') fetchArchive(`Shad.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/shad.bmd`);
            fetchArchive(`Shad1.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/shad_wait_a.bck`));
            });
        });
        //Gorons
        //Normal Gorons
        else if (name === 'grA' || name === 'Obj_grA') fetchArchive(`grA_mdl.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/gra_a.bmd`);

            fetchArchive(`grA_base.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/gra_wait_a.bck`));
            });
        });
        //Child Gorons
        else if (name === 'grC') fetchArchive(`grC_mdl.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/grc_a.bmd`);
            fetchArchive(`grC.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/grc_wait_a.bck`));
            });
        });
        //Gor Coron
        else if (name === 'grD' || name === 'grD1') fetchArchive(`grD.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/grd.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/grd_wait_a.bck`));
        });
        //Gor Ebizo
        else if (name === 'grO') fetchArchive(`grO.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/gro_a.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/gro_wait_a.bck`));
        });
        //Gor Liggs
        else if (name === 'grR') fetchArchive(`grR.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/grr.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/grr_wait_a.bck`));
        });
        //Gor Amato
        else if (name === 'grS') fetchArchive(`grS.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/grs.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/grs_wait_a.bck`));
        });
        //Darbus
        else if (name === 'grZ') fetchArchive(`grZ.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/grz.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/grz_wait_a.bck`));
        });
        //Lake Hylia
        //Thelma's Coach
        else if (name === 'Coach') fetchArchive(`Coach.arc`).then((rarc: RARC.RARC) => {
            //TODO Fix positions of models
            const coach = buildModel(rarc, `bmdr/coach.bmd`);
            const thelma = buildModel(rarc, `bmdr/theb.bmd`);
            thelma.bindANK1(parseBCK(rarc, `bck/theb_sit.bck`));

            const ilia = buildModel(rarc, `bmdr/yelia.bmd`);
            ilia.bindANK1(parseBCK(rarc, `bck/yelia_wait.bck`));

            const horse = buildModel(rarc, `bmdr/horse.bmd`);
            horse.bindANK1(parseBCK(rarc, `bck/hu_wait_01.bck`));
        });
        //Fyer
        else if (name === 'Toby') fetchArchive(`Toby.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/toby.bmd`);
            fetchArchive(`Toby0.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/toby_wait_a.bck`));
            });
        });
        //Falbi
        else if (name === 'Raca') fetchArchive(`Raca.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/raca.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/raca_wait_a.bck`));
        });
        //Auru
        else if (name === 'Rafrel') fetchArchive(`Rafrel.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/raf.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/raf_wait_a.bck`));
        });
        //Plumm
        else if (name === 'myna2') fetchArchive(`MYNA_b.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/myna_b.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/myna_b_wait_a.bck`));
        });
        //Zora's River
        //Iza
        else if (name === 'Hoz') fetchArchive(`Hoz.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/hoz.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/hoz_wait_a.bck`));
        });
        //Hena
        else if (name === 'Henna') fetchArchive(`Henna.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/henna.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/henna_wait_a.bck`));
        });
        //Zoras
        //Rutela
        else if (name === 'zraC') fetchArchive(`zrZ_GT.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/zrz_gt.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/zrz_wait_gt_a.bck`));
        });   
        //Prince Ralis
        else if (name === 'zrC') fetchArchive(`zrC_MDL.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdv/zrc.bmd`);
            fetchArchive(`zrC.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/zrc_wait_a.bck`));
            });
        });
        //Normal Zoras
        else if (name === 'zrA') fetchArchive(`zrA_MDL.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdv/zra.bmd`);
            fetchArchive(`zrA_sp.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/zra_wait_sp.bck`));
            });
        });        
        //Castle Town
        //Telma
        else if (name === 'The') fetchArchive(`The.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/the.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/the_wait_a.bck`));
        });
        //Louise - Telma's Cat
        else if (name === 'Peru') fetchArchive(`Peru.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/gz_ne.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/gz_ne_wait_a.bck`));
        });
        //Postman
        else if (name === 'Post') fetchArchive(`Post.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/post.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/post_wait_a.bck`));
        });
        //Jovani
        else if (name === 'Pouya') fetchArchive(`PouyaA.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdv/pouyaa.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/pouyaa_wait_a.bck`));
        });
        //Agitha
        else if (name === 'ins') fetchArchive(`Ins.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/ins.bmd`);
            fetchArchive(`Ins1.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/ins_wait_a.bck`));
            });
        });
        //Chudley
        else if (name === 'clerkA') fetchArchive(`clerkA.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/clerka.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/clerka_wait_a.bck`));
        });
        else if (name === 'clerkB') fetchArchive(`clerkB.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/clerkb.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/clerkb_wait_a.bck`));
        });
        //Soal
        else if (name === 'shoe') fetchArchive(`shoe.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/shoe.bmd`);
            // m.bindANK1(parseBCK(rarc, `bck/shoe_talk_a.bck`));//fix
        });
        //Dr. Borville
        else if (name === 'Doc') fetchArchive(`Doc.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/doc.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/doc_wait_a.bck`));
        });
        //Charlo
        else if (name === 'prayer') fetchArchive(`Prayer.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/prayer.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/w_pray.bck`));
        });
        //Purlo
        else if (name === 'chin') fetchArchive(`chin_mdl.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/chin.bmd`);
            // fetchArchive(`Chin.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/chin_wait_a.bck`));//fix
            // });
        });
        //Hannah
        else if (name === 'km_Hana') fetchArchive(`kasi_hana.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/hana.bmd`);
            // fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));//fix
            // });
        });
        //Kili
        else if (name === 'km_Kyu') fetchArchive(`kasi_kyu.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/kyu.bmd`);
            // fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));//fix
            // });
        });
        //Misha
        else if (name === 'km_Mich') fetchArchive(`kasi_mich.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mich.bmd`);
            // fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));//fix
            // });
        });
        //Random Castle Town NPCs
        else if (name === 'WAD_a') fetchArchive(`WAD_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wad_a.bmd`);
            fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            });
        });
        else if (name === 'WAD_a2') fetchArchive(`WAD_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wad_a2.bmd`);
            fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            });
        });
        else if (name === 'WAN_a') fetchArchive(`WAN_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wan_a.bmd`);
            fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            });
        });
        else if (name === 'WAN_a2') fetchArchive(`WAN_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wan_a2.bmd`);
            fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            });
        });
        else if (name === 'WAN_b') fetchArchive(`WAN_b.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wan_b.bmd`);
            // fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            // }); //fix
        });
        else if (name === 'WAN_b2') fetchArchive(`WAN_b2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wan_b2.bmd`);
            // fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            // }); //fix
        });
        else if (name === 'WGN_a') fetchArchive(`WGN_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wgn_a.bmd`);
            // fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            // }); //fix
        });
        else if (name === 'WGN_a2') fetchArchive(`WGN_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wgn_a2.bmd`);
            // fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            // }); //fix
        });
        else if (name === 'WCN_a') fetchArchive(`WCN_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wcn_a.bmd`);
            // fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            // });//fix
        });
        else if (name === 'WCN_a2') fetchArchive(`WCN_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/wcn_a2.bmd`);
            // fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            // });//fix
        });
        else if (name === 'WON_a2') fetchArchive(`WON_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/won_a2.bmd`);
            fetchArchive(`Wgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/w_wait_a.bck`));
            });
        });
        else if (name === 'DoorBoy') fetchArchive(`DoorBoy.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/doorboy.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MAN_a') fetchArchive(`MAN_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/man_a.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MAN_a2') fetchArchive(`MAN_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/man_a2.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MCN_a') fetchArchive(`MCN_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mcn_a.bmd`);
            // fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            // });//fix
        });
        else if (name === 'MCN_a2') fetchArchive(`MCN_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mcn_a2.bmd`);
            // fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            // });//fix
        });
        else if (name === 'MAN_b') fetchArchive(`MAN_b.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/man_b.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MAN_c') fetchArchive(`MAN_c.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/man_c.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MAT_a') fetchArchive(`MAT_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mat_a.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MAT_a2') fetchArchive(`MAT_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mat_a2.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MAS_a') fetchArchive(`MAS_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mas_a.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MAD_a') fetchArchive(`MAD_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mad_a.bmd`);
            // fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            // });//fix
        });
        else if (name === 'MAD_a2') fetchArchive(`MAD_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mad_a2.bmd`);
            // fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
            //     m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            // });//fix
        });
        else if (name === 'MBN_a') fetchArchive(`MBN_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mbn_a.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MBN_a2') fetchArchive(`MBN_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mbn_a2.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MON_a') fetchArchive(`MON_a.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mon_a.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        else if (name === 'MON_a2') fetchArchive(`MON_a2.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mon_a.bmd`);
            fetchArchive(`Mgeneral.arc`).then((animrarc: RARC.RARC) => {
                m.bindANK1(parseBCK(animrarc, `bck/m_wait_a.bck`));
            });
        });
        //Snowpeak NPCs
        //Yeta
        else if (name === 'ykW') fetchArchive(`ykW.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/ykw.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/ykw_wait_a.bck`));
        });
        //Yeto
        else if (name === 'ykM') fetchArchive(`ykM.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/ykm.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/ykm_wait_a.bck`));
        });
        //Ashei
        else if (name === 'Ash') fetchArchive(`Ash.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/ash.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/ash_wait_a.bck`));
        });
        //Other NPCs
        //Zelda
        else if (name === 'Zelda' || name === 'Hzelda') fetchArchive(`Zelda.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmde/zelda.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/zelda_wait_a.bck`));
        });
        else if (name === 'Dmidna') fetchArchive(`Midna.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdv/s_md.bmd`);
            //m.bindANK1(parseBCK(rarc, `bck/midna_wait_a.bck`));
        });
        //Mini Bosses
        //Ook Boss Monkey
        else if (name === 'E_mk') fetchArchive(`E_mk.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmdr/mk.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/mk_wait.bck`));
        });
        //Bosses
        //Blizzeta
        else if (name === 'B_yo') fetchArchive(`B_yo.arc`).then((rarc: RARC.RARC) => {
            const m = buildModel(rarc, `bmde/ykw_b.bmd`);
            m.bindANK1(parseBCK(rarc, `bck/ykw_b_waita.bck`));
        });
        //Objects
        //Pumpkin
        else if (name === 'Pumpkin') fetchArchive(`pumpkin.arc`).then((rarc) => buildModel(rarc, `bmdr/pumpkin.bmd`));
        else
        {
            console.warn(`Unknown object: ${name}`);
        }
    }
    public createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const dataFetcher = context.dataFetcher;
        const stagePath = `${pathBase}/res/Stage/${this.stageId}`;
        const extraTextures = new ZTPExtraTextures();
        const modelCache = new ModelCache(dataFetcher);

        return this.fetchRarc(`${stagePath}/STG_00.arc`, dataFetcher).then((stageRarc: RARC.RARC) => {
            // Load stage shared textures.
            const texcFolder = stageRarc.findDir(`texc`);
            const extraTextureFiles = texcFolder !== null ? texcFolder.files : [];

            for (let i = 0; i < extraTextureFiles.length; i++) {
                const file = extraTextureFiles[i];
                const name = file.name.split('.')[0];
                const bti = BTI.parse(file.buffer, name).texture;
                extraTextures.addBTI(device, bti);
            }

            const renderer = new TwilightPrincessRenderer(device, modelCache, extraTextures, stageRarc);

            const cache = renderer.renderHelper.renderInstManager.gfxRenderCache;

            [`vrbox_sora`, `vrbox_kasumim`].forEach((basename) => {
                const bmdFile = stageRarc.findFile(`bmdp/${basename}.bmd`);
                if (!bmdFile)
                    return null;
                const btkFile = stageRarc.findFile(`btk/${basename}.btk`);
                const brkFile = stageRarc.findFile(`brk/${basename}.brk`);
                const bckFile = stageRarc.findFile(`bck/${basename}.bck`);
                const scene = createModelInstance(device, cache, extraTextures, bmdFile, btkFile, brkFile, bckFile, null);
                scene.name = `stage/${basename}`;
                scene.isSkybox = true;
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

            return Promise.all(roomNames.map((roomName) => this.fetchRarc(`${stagePath}/${roomName}.arc`, dataFetcher))).then((roomRarcs: (RARC.RARC | null)[]) => {
                roomRarcs.forEach((rarc: RARC.RARC | null, i) => {
                    if (rarc === null) return;
                    this.createRoomScenes(device, renderer, rarc, roomNames[i]);
                });

                return modelCache.waitForLoad().then(() => 
                {
                    return renderer;
                });
            });
        });
    }

    private async fetchRarc(path: string, dataFetcher: DataFetcher): Promise<RARC.RARC | null> {
        const buffer = await dataFetcher.fetchData(path, DataFetcherFlags.ALLOW_404);
        if (buffer.byteLength === 0)
            return null;
        const decompressed = await Yaz0.decompress(buffer);
        return RARC.parse(decompressed);
    }
}

const id = "ztp";
const name = "The Legend of Zelda: Twilight Princess";

// Special thanks to Jawchewa and SkrillerArt for helping me with naming the maps.
const sceneDescs = [
    "Ordon Province",
    new TwilightPrincessSceneDesc("Ordon Village", "F_SP103", ["R00_00"]),
    new TwilightPrincessSceneDesc("Link's House Area", "F_SP103", ['R01_00']),
    new TwilightPrincessSceneDesc("Ordon Ranch", "F_SP00"),
    new TwilightPrincessSceneDesc("Ordon Woods", "F_SP104"),

    "Ordon Province Indoors",
    new TwilightPrincessSceneDesc("Mayor's House", "R_SP01", ["R00_00"]),
    new TwilightPrincessSceneDesc("Sera's Sundries", "R_SP01", ["R01_00"]),
    new TwilightPrincessSceneDesc("Talo and Malo's House", "R_SP01", ["R02_00"]),
    new TwilightPrincessSceneDesc("Link's House", "R_SP01", ["R04_00", "R07_00"]),
    new TwilightPrincessSceneDesc("Rusl's House", "R_SP01", ["R05_00"]),

    "Faron Province", 
    new TwilightPrincessSceneDesc("Faron Woods", "F_SP108"),//TODO: Split up
    new TwilightPrincessSceneDesc("Coro's House", "R_SP108"),
    new TwilightPrincessSceneDesc("Sacred Grove", "F_SP117", ["R01_00"]),
    new TwilightPrincessSceneDesc("Sacred Grove - Temple of Time Entrance", "F_SP117", ["R02_00"]),
    new TwilightPrincessSceneDesc("Sacred Grove Forest", "F_SP117", ["R03_00"]),

    "Kakariko Village",
    new TwilightPrincessSceneDesc("Kakariko Village", "F_SP109"),
    new TwilightPrincessSceneDesc("Kakariko Graveyard", "F_SP111"),

    "Kakariko Village Indoors",
    new TwilightPrincessSceneDesc("Barnes Bomb Shop", "R_SP109", ["R01_00"]),
    new TwilightPrincessSceneDesc("Elde Inn", "R_SP109", ["R02_00"]),
    new TwilightPrincessSceneDesc("Malo Mart", "R_SP109", ["R03_00"]),
    new TwilightPrincessSceneDesc("Watch Tower", "R_SP109", ["R04_00"]),
    new TwilightPrincessSceneDesc("Flammable House", "R_SP109", ["R05_00"]),
    new TwilightPrincessSceneDesc("Abandoned House", "R_SP109", ["R06_00"]),
    new TwilightPrincessSceneDesc("Kakariko Sanctuary", "R_SP109", ["R00_00"]),
    new TwilightPrincessSceneDesc("Kakariko Sanctuary Cellar", "R_SP209"),

    "Death Mountain",
    new TwilightPrincessSceneDesc("Death Mountain", "F_SP110"),
    new TwilightPrincessSceneDesc("Goron Mines Entrance", "R_SP110"),

    "Lake Hylia",
    new TwilightPrincessSceneDesc("Lake Hylia", "F_SP115", ["R00_00"]),
    new TwilightPrincessSceneDesc("Lanayru's Spring", "F_SP115", ["R01_00"]),
    
    "Zora's Domain",
    new TwilightPrincessSceneDesc("Zora's Domain", "F_SP113", ["R01_00"]),
    new TwilightPrincessSceneDesc("Throne Room", "F_SP113", ["R00_00"]),
    new TwilightPrincessSceneDesc("Zora's River", "F_SP126"),
    new TwilightPrincessSceneDesc("Rapids Ride", "F_SP112"),

    "Fishing Hole",
    new TwilightPrincessSceneDesc("Fishing Pond", "F_SP127"),
    new TwilightPrincessSceneDesc("Hena's Fishing Hole - Indoors", "R_SP127"),

    "Castle Town", 
    new TwilightPrincessSceneDesc("Castle Town Central Square", "F_SP116", ["R00_00"]),
    new TwilightPrincessSceneDesc("Hyrule Castle Entrance", "F_SP116", ["R01_00"]),
    new TwilightPrincessSceneDesc("Castle Town West Road", "F_SP116", ["R02_00"]),
    new TwilightPrincessSceneDesc("Castle Town South Road", "F_SP116", ["R03_00"]),
    new TwilightPrincessSceneDesc("Castle Town East Road", "F_SP116", ["R04_00"]),

    "Castle Town Indoors",
    new TwilightPrincessSceneDesc("Telma's Bar", "R_SP116", ["R05_00"]),
    new TwilightPrincessSceneDesc("Castle Town Sewers", "R_SP116", ["R06_00"]),

    new TwilightPrincessSceneDesc("Malo Mart / Chudley's Fine Goods and Fancy Trinkets Emporium", "R_SP160", ["R00_00"]),
    new TwilightPrincessSceneDesc("Fanadi's Palace", "R_SP160", ["R01_00"]),
    new TwilightPrincessSceneDesc("Medical Clinic", "R_SP160", ["R02_00"]),
    new TwilightPrincessSceneDesc("Agitha's Castle", "R_SP160", ["R03_00"]),
    new TwilightPrincessSceneDesc("Goron Watch Tower", "R_SP160", ["R04_00"]),
    new TwilightPrincessSceneDesc("Jovani's House", "R_SP160", ["R05_00"]),

    new TwilightPrincessSceneDesc("STAR Tent", "R_SP161"),

    "Snowpeak Mountain",
    new TwilightPrincessSceneDesc("Snowpeak Mountain", "F_SP114", ["R00_00"]),
    new TwilightPrincessSceneDesc("Snowpeak Top", "F_SP114", ["R01_00"]),
    new TwilightPrincessSceneDesc("Snowpeak Cave", "F_SP114", ["R02_00"]),
    
    "Gerudo Desert",
    new TwilightPrincessSceneDesc("Gerudo Desert", "F_SP124"),
    new TwilightPrincessSceneDesc("Gerudo Desert Bulblin Base", "F_SP118"),
    new TwilightPrincessSceneDesc("Arbiter's Grounds Mirror Chamber", "F_SP125"),

    "Hidden Village",
    new TwilightPrincessSceneDesc("Hidden Village", "F_SP128"),
    new TwilightPrincessSceneDesc("Impaz's House", "R_SP128"),

    "Hyrule Field",
    new TwilightPrincessSceneDesc("Hyrule Field Map 1", "F_SP102"),
    new TwilightPrincessSceneDesc("Hyrule Field Map 2", "F_SP121"),
    new TwilightPrincessSceneDesc("Hyrule Field Map 3", "F_SP122"),
    new TwilightPrincessSceneDesc("Hyrule Field Map 4", "F_SP123"),
    new TwilightPrincessSceneDesc("Wolf Howling Cutscene Map", "F_SP200"),
    new TwilightPrincessSceneDesc("Final Boss Arena (On Horseback)", "D_MN09B"),
    new TwilightPrincessSceneDesc("Final Boss Arena", "D_MN09C"),
    
    "Forest Temple",
    new TwilightPrincessSceneDesc("Forest Temple", "D_MN05"),
    new TwilightPrincessSceneDesc("Forest Temple Boss Arena", "D_MN05A"),
    new TwilightPrincessSceneDesc("Forest Temple Mini-Boss Arena", "D_MN05B"),

    "Goron Mines",
    new TwilightPrincessSceneDesc("Goron Mines", "D_MN04"),
    new TwilightPrincessSceneDesc("Goron Mines Boss Arena", "D_MN04A"),
    new TwilightPrincessSceneDesc("Goron Mines Mini-Boss Arena", "D_MN04B"),

    "Lakebed Temple",
    new TwilightPrincessSceneDesc("Lakebed Temple", "D_MN01"),
    new TwilightPrincessSceneDesc("Lakebed Temple Boss Arena", "D_MN01A"),
    new TwilightPrincessSceneDesc("Lakebed Temple Mini-Boss Arena", "D_MN01B"),

    "Arbiter's Grounds",
    new TwilightPrincessSceneDesc("Arbiter's Grounds", "D_MN10"),
    new TwilightPrincessSceneDesc("Arbiter's Grounds Boss Arena", "D_MN10A"),
    new TwilightPrincessSceneDesc("Arbiter's Grounds Mini-Boss Arena", "D_MN10B"),

    "Snowpeak Ruins",
    new TwilightPrincessSceneDesc("Snowpeak Ruins", "D_MN11"),
    new TwilightPrincessSceneDesc("Snowpeak Ruins Boss Arena", "D_MN11A"),
    new TwilightPrincessSceneDesc("Snowpeak Ruins Mini-Boss Arena", "D_MN11B"),

    "Temple of Time",
    new TwilightPrincessSceneDesc("Temple of Time", "D_MN06"),
    new TwilightPrincessSceneDesc("Temple of Time Boss Arena", "D_MN06A"),
    new TwilightPrincessSceneDesc("Temple of Time Mini-Boss Arena", "D_MN06B"),

    "City in the Sky",
    new TwilightPrincessSceneDesc("City in the Sky", "D_MN07"),
    new TwilightPrincessSceneDesc("City in the Sky Boss Arena", "D_MN07A"),
    new TwilightPrincessSceneDesc("City in the Sky Mini-Boss Arena", "D_MN07B"),

    "Palace of Twilight", 
    new TwilightPrincessSceneDesc("Palace of Twilight", "D_MN08"),
    new TwilightPrincessSceneDesc("Palace of Twilight Boss Arena 1", "D_MN08A"),
    new TwilightPrincessSceneDesc("Palace of Twilight Mini-Boss Arena 1", "D_MN08B"),
    new TwilightPrincessSceneDesc("Palace of Twilight Mini-Boss Arena 2", "D_MN08C"),
    new TwilightPrincessSceneDesc("Palace of Twilight Boss Rush Arena", "D_MN08D"),

    "Hyrule Castle",
    new TwilightPrincessSceneDesc("Hyrule Castle Wolf Escape", "R_SP107"),
    new TwilightPrincessSceneDesc("Hyrule Castle", "D_MN09"),
    new TwilightPrincessSceneDesc("Hyrule Castle Boss Arena", "D_MN09A"),

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

    "Cutscenes",
    new TwilightPrincessSceneDesc("Hyrule Castle Throne Room", "R_SP301"),  
    new TwilightPrincessSceneDesc("Light Arrow Area", "R_SP300"),
  
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
