
import * as Viewer from '../viewer';
import * as UI from '../ui';
import * as Yaz0 from '../compression/Yaz0';
import * as RARC from './rarc';

import ArrayBufferSlice from '../ArrayBufferSlice';
import Progressable from '../Progressable';
import { readString, assert, makeTextDecoder } from '../util';
import { fetchData } from '../fetch';

import { J3DTextureHolder, BMDModelInstance, BMDModel } from './render';
import { createModelInstance } from './scenes';
import { EFB_WIDTH, EFB_HEIGHT, Color } from '../gx/gx_material';
import { mat4, quat } from 'gl-matrix';
import { LoopMode, BMD, BMT, BCK, BTK, BRK, BTI } from './j3d';
import { TextureOverride } from '../TextureHolder';
import { GXRenderHelperGfx, ColorKind } from '../gx/gx_render';
import { GfxRenderInstViewRenderer } from '../gfx/render/GfxRenderer';
import { BasicRenderTarget, ColorTexture, makeClearRenderPassDescriptor, depthClearRenderPassDescriptor, noClearRenderPassDescriptor } from '../gfx/helpers/RenderTargetHelpers';
import { GfxDevice, GfxHostAccessPass, GfxRenderPass } from '../gfx/platform/GfxPlatform';
import { colorNew } from '../Color';
import { RENDER_HACKS_ICON } from '../bk/scenes';
import { BMDObjectRenderer } from './sms_actors';

const sjisDecoder = makeTextDecoder('sjis');

function unpack(buffer: ArrayBufferSlice, sig: string): any[] {
    const view = buffer.createDataView();
    const result: any[] = [];
    let offs = 0;
    let allowExtra = false;
    for (let i = 0; i < sig.length; i++) {
        switch (sig[i]) {
        case 'B':
            result.push(view.getUint8(offs));
            offs += 0x01;
            break;
        case 'I':
            result.push(view.getUint32(offs));
            offs += 0x04;
            break;
        case 'i':
            result.push(view.getInt32(offs));
            offs += 0x04;
            break;
        case 'f':
            result.push(view.getFloat32(offs));
            offs += 0x04;
            break;
        case 's':
            const size = view.getUint16(offs);
            offs += 0x02;
            result.push(readString(buffer, offs, size, false));
            offs += size;
            break;
        case '.':
            allowExtra = true;
            break;
        case ' ':
            break;
        default:
            assert(false);
        }
    }

    if (!allowExtra) {
        assert(buffer.byteLength === offs);
    }

    return [offs, ...result];
}

interface SceneBinObjBase {
    klass: string;
    name: string;
    size: number;
}

interface SceneBinObjUnk extends SceneBinObjBase {
    type: 'Unknown';
}

interface SceneBinObjAmbColor extends SceneBinObjBase {
    type: 'AmbColor';
    klass: 'AmbColor';
    r: number;
    g: number;
    b: number;
    a: number;
}

interface SceneBinObjLight extends SceneBinObjBase {
    type: 'Light';
    klass: 'Light';
    x: number;
    y: number;
    z: number;
    r: number;
    g: number;
    b: number;
    a: number;
    intensity: number;
}

interface SceneBinObjModel extends SceneBinObjBase {
    type: 'Model';
    x: number;
    y: number;
    z: number;
    rotationX: number;
    rotationY: number;
    rotationZ: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
    manager: string;
    model: string;
    bodyColor?: number;
    shirtColor?: number;
    accessoryColor?: number;
    state?: number;
}

interface SceneBinObjGroup extends SceneBinObjBase {
    type: 'Group';
    klass: 'GroupObj' | 'Strategy' | 'AmbAry' | 'LightAry' | 'MarScene' | 'IdxGroup';
    children: SceneBinObj[];
}

type SceneBinObj = SceneBinObjGroup | SceneBinObjAmbColor | SceneBinObjLight | SceneBinObjModel | SceneBinObjUnk;

function readSceneBin(buffer: ArrayBufferSlice): SceneBinObj {
    let offs = 0x00;
    const view_ = buffer.createDataView();
    const size = view_.getUint32(offs + 0x00);
    const view = buffer.createDataView(0x00, size);
    offs += 0x04;
    const klassHash = view.getUint16(offs + 0x00);
    const klassSize = view.getUint16(offs + 0x02);
    offs += 0x04;
    const klass = readString(buffer, offs, klassSize, false);
    offs += klassSize;
    const nameHash = view.getUint16(offs + 0x00);
    const nameSize = view.getUint16(offs + 0x02);
    offs += 0x04;
    const name = sjisDecoder.decode(buffer.copyToBuffer(offs, nameSize));
    offs += nameSize;

    function readChildren(numChildren: number): SceneBinObj[] {
        const children = [];
        while (numChildren--) {
            const child = readSceneBin(buffer.slice(offs));
            children.push(child);
            offs += child.size;
        }
        return children;
    }

    const params = buffer.slice(offs, size);

    switch (klass) {
    case 'GroupObj':
    case 'LightAry':
    case 'Strategy':
    case 'AmbAry':
    {
        const [paramsSize, numChildren] = unpack(params, 'I.');
        offs += paramsSize;
        const children = readChildren(numChildren);
        return { type: 'Group', klass, name, size, children };
    }
    case 'IdxGroup':
    case 'MarScene':
    {
        const [paramsSize, flags, numChildren] = unpack(params, 'II.');
        offs += paramsSize;
        const children = readChildren(numChildren);
        return { type: 'Group', klass, name, size, children };
    }
    case 'AmbColor':
    {
        const [paramsSize, r, g, b, a] = unpack(params, 'BBBB');
        return { type: 'AmbColor', klass, name, size, r, g, b, a };
    }
    case 'Light':
    {
        const [paramsSize, x, y, z, r, g, b, a, intensity] = unpack(params, 'fffBBBBf');
        return { type: 'Light', klass, name, size, x, y, z, r, g, b, a, intensity };
    }
    // Models
    case 'BananaTree':
    case 'Bathtub':
    case 'BellDolpicPolice':
    case 'BellDolpicTV':
    case 'BiaBell':
    case 'BiaTurnBridge':
    case 'BiaWatermill':
    case 'BiaWatermillVertical':
    case 'BigWindmill':
    case 'Coin':
    case 'CoinRed':
    case 'CraneRotY':
    case 'craneUpDown':
    case 'Fence':
    case 'FenceInner':
    case 'FenceRevolve':
    case 'FenceWaterH':
    case 'FenceWaterV':
    case 'FerrisWheel':
    case 'FlowerCoin':
    case 'IceBlock':
    case 'LeafBoat':
    case 'LeanMirror':
    case 'Manhole':
    case 'MammaYacht':
    case 'MapObjBase':
    case 'MapObjGeneral':
    case 'MapObjRootPakkun':
    case 'MapObjSmoke':
    case 'MapObjTreeScale':
    case 'MapStaticObj':
    case 'Merrygoround':
    case 'MiniWindmill':
    case 'MonumentShine':
    case 'Palm':
    case 'PalmNatume':
    case 'PalmOugi':
    case 'PinnaDoor':
    case 'RiccoLog':
    case 'riccoWatermill':
    case 'RiccoSwitchShine':
    case 'SandCastle':
    case 'SandEgg':
    case 'ShellCup':
    case 'ShiningStone':
    case 'WoodBarrel':
    case 'WoodBlock':
    case 'ResetFruit':
    case 'SandBombBase':
    case 'SandBomb':
    case 'TurboNozzleDoor':
    case 'Viking':
    case 'WindmillRoof':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, flags, model] = unpack(params, 'ffffff fffsi s.');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model };
    }  
    case 'SunModel':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, flags] = unpack(params, 'ffffff fffsi');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model: klass };
    }

    case 'EMario':
    case 'Amenbo':
    case 'AnimalBird':
    case 'AnimalMew':
    case 'BathtubPeach':
    case 'BossDangoHamuKuri':
    case 'BossEel':
    case 'BossGesso':
    case 'BossPakkun':
    case 'EggYoshi':
    case 'FishoidA':
    case 'FishoidB':
    case 'FishoidC':
    case 'FishoidD':
    case 'GateKeeper':
    case 'Gesso':
    case 'Kazekun':
    case 'KBossPakkun':
    case 'Koopa':
    case 'KoopaJr':  
    case 'LandGesso':
    case 'LimitKoopaJr':
    case 'MameGesso':
    case 'NPCBoard':
    case 'NPCKinojii':
    case 'NPCMareM':
    case 'NPCMareMC':
    case 'NPCMareMD':
    case 'NPCMareW':
    case 'NPCMareWB':
    case 'NPCPeach':
    case 'NPCRacoonDog':
    case 'PoiHana':
    case 'PoiHanaRed':
    case 'TabePuku':
    case 'RiccoSwitch':
    case 'SamboHead':
    case 'SamboFlower':
    case 'StayPakkun':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, flags, model] = unpack(params, 'ffffff fffsi s.');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model: klass };
    }
    case 'NPCMonteMA':
    case 'NPCMonteMB':
    case 'NPCMonteMC':
    case 'NPCMonteMD':
    case 'NPCMonteME':
    case 'NPCMonteMH':
    case 'NPCMonteMG':
    case 'NPCMonteM':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, charManager, flags, manager, rail, bodyColor, shirtColor, state, hat, accessoryColor ] = unpack(params, 'ffffff fffsi s s iii i iii.');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model: klass, bodyColor, shirtColor, state, accessoryColor };
    }
    
    case 'NPCMonteW':
    case 'NPCMonteWB':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, charManager, flags, manager, rail, bodyColor, shirtColor, state, hat, accessoryColor ] = unpack(params, 'ffffff fffsi s s iiii iiii iiii.');
        console.log(unpack(params, 'ffffff fffsi s s iiii iiii iiii.'));
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model: klass, bodyColor, shirtColor, state, accessoryColor };
    }
    case 'NPCKinopio':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, charManager, flags, manager, rail, bodyColor] = unpack(params, 'ffffff fffsi s s i.');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model: klass, bodyColor };
    }
    // Extra unk junk
    case 'CoinBlue':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, flags, model] = unpack(params, 'ffffff fffsi s i');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model };
    }
    case 'NozzleBox':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, flags, model] = unpack(params, 'ffffff fffsi s ssff');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model };
    }
    case 'Shine':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, flags, model] = unpack(params, 'ffffff fffsi s sii');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model };
    }
    case 'FruitsBoatB':
    case 'FruitsBoat':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, flags, model] = unpack(params, 'ffffff fffsi s s');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model: 'FruitsBoat' };
    }
    case 'Billboard':
    case 'BrickBlock':
    case 'DolWeathercock':
    case 'WoodBox':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, flags, model] = unpack(params, 'ffffff fffsI s IffI');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model };
    }
    case 'MapObjWaterSpray':
    {
        const [paramsSize, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, flags, model] = unpack(params, 'ffffff fffsI s IIIIII');
        return { type: 'Model', klass, name, size, x, y, z, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, manager, model };
    }
    default:
        let warnUnknown = true;

        // Managers are internal.
        if (klass.endsWith('Manager') || klass.endsWith('Mgr'))
            warnUnknown = false;
        // Cube maps...
        if (klass.startsWith('Cube'))
            warnUnknown = false;

        if (warnUnknown)
            console.warn(`Unknown object class ${klassHash} ${klass}, size ${size}`);

        return { type: 'Unknown', klass, name, size };
    }
}

export const enum SMSPass {
    SKYBOX = 1 << 0,
    OPAQUE = 1 << 1,
    INDIRECT = 1 << 2,
    TRANSPARENT = 1 << 3,
}

const sunshineClearDescriptor = makeClearRenderPassDescriptor(true, colorNew(0, 0, 0.125, 1));

export class SunshineRenderer implements Viewer.SceneGfx {
    public renderHelper: GXRenderHelperGfx;
    public viewRenderer = new GfxRenderInstViewRenderer();
    public mainRenderTarget = new BasicRenderTarget();
    public opaqueSceneTexture = new ColorTexture();
    public models: BMDObjectRenderer[] = [];
    public objectModels: BMDObjectRenderer[] = [];
    public objectsVisible: boolean = true;

    constructor(device: GfxDevice, public textureHolder: J3DTextureHolder, public rarc: RARC.RARC) {
        this.renderHelper = new GXRenderHelperGfx(device);
    }

    public createPanels(): UI.Panel[] {
        const renderHacksPanel = new UI.Panel();
        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(RENDER_HACKS_ICON, 'Render Hacks');
        const enableVertexColorsCheckbox = new UI.Checkbox('Enable Vertex Colors', true);
        enableVertexColorsCheckbox.onchanged = () => {
            for (let i = 0; i < this.models.length; i++)
                this.models[i].setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
            for (let i = 0; i < this.objectModels.length; i++)
                this.objectModels[i].setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
        };
        renderHacksPanel.contents.appendChild(enableVertexColorsCheckbox.elem);
        const enableTextures = new UI.Checkbox('Enable Textures', true);
        enableTextures.onchanged = () => {
            for (let i = 0; i < this.models.length; i++)
                this.models[i].setTexturesEnabled(enableTextures.checked);
            for (let i = 0; i < this.objectModels.length; i++)
                this.objectModels[i].setTexturesEnabled(enableTextures.checked);
        };
        renderHacksPanel.contents.appendChild(enableTextures.elem);
        const enableObjects = new UI.Checkbox('Enable Objects', true);
        enableObjects.onchanged = () => {
            this.objectsVisible = enableObjects.checked;
        };
        renderHacksPanel.contents.appendChild(enableObjects.elem);

        return [renderHacksPanel];
    }

    public finish(device: GfxDevice): void {
        this.renderHelper.finishBuilder(device, this.viewRenderer);
    }

    protected prepareToRender(hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput): void {
        viewerInput.camera.setClipPlanes(20, 800000);
        this.renderHelper.fillSceneParams(viewerInput);
        for (let i = 0; i < this.models.length; i++)
            this.models[i].prepareToRender(this.renderHelper, viewerInput, true);
        for (let i = 0; i < this.objectModels.length; i++)
            this.objectModels[i].prepareToRender(this.renderHelper, viewerInput, this.objectsVisible);
        this.renderHelper.prepareToRender(hostAccessPass);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();
        this.prepareToRender(hostAccessPass, viewerInput);
        device.submitPass(hostAccessPass);

        this.viewRenderer.prepareToRender(device);

        this.mainRenderTarget.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
        this.opaqueSceneTexture.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
        this.viewRenderer.setViewport(viewerInput.viewportWidth, viewerInput.viewportHeight);

        const skyboxPassRenderer = this.mainRenderTarget.createRenderPass(device, sunshineClearDescriptor);
        this.viewRenderer.executeOnPass(device, skyboxPassRenderer, SMSPass.SKYBOX);
        skyboxPassRenderer.endPass(null);
        device.submitPass(skyboxPassRenderer);

        const opaquePassRenderer = this.mainRenderTarget.createRenderPass(device, depthClearRenderPassDescriptor);
        this.viewRenderer.executeOnPass(device, opaquePassRenderer, SMSPass.OPAQUE);

        let lastPassRenderer: GfxRenderPass;
        const textureOverride: TextureOverride = { gfxTexture: this.opaqueSceneTexture.gfxTexture, width: EFB_WIDTH, height: EFB_HEIGHT, flipY: true };

        if (this.viewRenderer.hasAnyVisible(SMSPass.INDIRECT)) {
            opaquePassRenderer.endPass(this.opaqueSceneTexture.gfxTexture);
            device.submitPass(opaquePassRenderer);

            // IndTex.
            this.textureHolder.setTextureOverride("indirectdummy", textureOverride);

            const indTexPassRenderer = this.mainRenderTarget.createRenderPass(device, noClearRenderPassDescriptor);
            this.viewRenderer.executeOnPass(device, indTexPassRenderer, SMSPass.INDIRECT);
            lastPassRenderer = indTexPassRenderer;
        } else {
            lastPassRenderer = opaquePassRenderer;
        }

        this.textureHolder.setTextureOverride("H_ma_polmask_sample_i4", textureOverride, false);
        this.textureHolder.setTextureOverride("H_shinemonument_polmask1_i4", textureOverride, false);
        // Window & transparent.
        this.viewRenderer.executeOnPass(device, lastPassRenderer, SMSPass.TRANSPARENT);
        return lastPassRenderer;
    }

    public destroy(device: GfxDevice) {
        this.renderHelper.destroy(device);
        this.viewRenderer.destroy(device);
        this.textureHolder.destroy(device);
        this.mainRenderTarget.destroy(device);
        this.opaqueSceneTexture.destroy(device);
        this.models.forEach((instance) => instance.destroy(device));
        this.objectModels.forEach((instance) => instance.destroy(device));
    }
}

export class SunshineSceneDesc implements Viewer.SceneDesc {
    public static createSunshineSceneForBasename(device: GfxDevice, renderHelper: GXRenderHelperGfx, textureHolder: J3DTextureHolder, passMask: number, rarc: RARC.RARC, basename: string, isSkybox: boolean): BMDObjectRenderer {
        const bmdFile = rarc.findFile(`${basename}.bmd`);
        if (!bmdFile)
            return null;
        const btkFile = rarc.findFile(`${basename}.btk`);
        const brkFile = rarc.findFile(`${basename}.brk`);
        const bckFile = rarc.findFile(`${basename}.bck`);
        const bmtFile = rarc.findFile(`${basename}.bmt`);
        const modelInstance = createModelInstance(device, renderHelper, textureHolder, bmdFile, btkFile, brkFile, bckFile, bmtFile);
        modelInstance.name = basename;
        modelInstance.setIsSkybox(isSkybox);
        modelInstance.passMask = passMask;
        return new BMDObjectRenderer(modelInstance);
    }

    constructor(public id: string, public name: string) {
    }

    public createScene(device: GfxDevice): Progressable<Viewer.SceneGfx> {
        const pathBase = `j3d/sms`;
        const path = `${pathBase}/${this.id}.szs`;
        return fetchData(path).then((result: ArrayBufferSlice) => {
            return Yaz0.decompress(result);
        }).then((buffer: ArrayBufferSlice) => {
            const rarc = RARC.parse(buffer);

            const sceneBin = rarc.findFile('map/scene.bin');
            const sceneBinObj = readSceneBin(sceneBin.buffer);
            console.log(sceneBinObj);

            const textureHolder = new J3DTextureHolder();
            const renderer = new SunshineRenderer(device, textureHolder, rarc);

            const skyScene = SunshineSceneDesc.createSunshineSceneForBasename(device, renderer.renderHelper, textureHolder, SMSPass.SKYBOX, rarc, 'map/map/sky', true);
            if (skyScene !== null)
                renderer.models.push(skyScene);
            const mapScene = SunshineSceneDesc.createSunshineSceneForBasename(device, renderer.renderHelper, textureHolder, SMSPass.OPAQUE, rarc, 'map/map/map', false);
            if (mapScene !== null)
                renderer.models.push(mapScene);
            const seaScene = SunshineSceneDesc.createSunshineSceneForBasename(device, renderer.renderHelper, textureHolder, SMSPass.OPAQUE, rarc, 'map/map/sea', false);
            if (seaScene !== null)
                renderer.models.push(seaScene);
            const seaIndirectScene = SunshineSceneDesc.createSunshineSceneForBasename(device, renderer.renderHelper, textureHolder, SMSPass.INDIRECT, rarc, 'map/map/seaindirect', false);
            if (seaIndirectScene !== null)
                renderer.models.push(seaIndirectScene);

            const extraScenes = this.createSceneBinObjects(device, renderer.renderHelper, textureHolder, rarc, sceneBinObj);
            for (let i = 0; i < extraScenes.length; i++)
                renderer.objectModels.push(extraScenes[i]);

            renderer.finish(device);
            return renderer;
        });
    }

    private createSceneBinObjects(device: GfxDevice, renderHelper: GXRenderHelperGfx, textureHolder: J3DTextureHolder, rarc: RARC.RARC, obj: SceneBinObj): BMDObjectRenderer[] {
        function flatten<T>(L: T[][]): T[] {
            const R: T[] = [];
            for (const Ts of L)
                R.push.apply(R, Ts);
            return R;
        }

        switch (obj.type) {
        case 'Group':
            const childTs: BMDObjectRenderer[][] = obj.children.map(c => this.createSceneBinObjects(device, renderHelper, textureHolder, rarc, c));
            const flattened: BMDObjectRenderer[] = flatten(childTs).filter(o => !!o);
            return flattened;
        case 'Model':
            return [this.createSceneForSceneBinModel(device, renderHelper, textureHolder, rarc, obj)];
        default:
            // Don't care.
            return undefined;
        }
    }

    private createSceneForSceneBinModel(device: GfxDevice, renderHelper: GXRenderHelperGfx, textureHolder: J3DTextureHolder, rarc: RARC.RARC, obj: SceneBinObjModel): BMDObjectRenderer {
        interface ModelLookup {
            k: string; // klass
            m: string; // model
            p?: string; // resulting file prefix
            s?: () => BMDObjectRenderer;
        };

        const modelCache = new Map<RARC.RARCFile, BMDModel>();
        function lookupModel(bmdFile: RARC.RARCFile, bmtFile: RARC.RARCFile | null): BMDModel {
            assert(!!bmdFile);
            if (modelCache.has(bmdFile)) {
                return modelCache.get(bmdFile);
            } else {
                const bmd = BMD.parse(bmdFile.buffer);
                const bmt = bmtFile !== null ? BMT.parse(bmtFile.buffer) : null;
                textureHolder.addJ3DTextures(device, bmd, bmt);
                const bmdModel = new BMDModel(device, renderHelper, bmd, bmt);
                modelCache.set(bmdFile, bmdModel);
                return bmdModel;
            }
        }

        function bmtm(bmd: string, bmt: string): BMDObjectRenderer {
            const bmdFile = rarc.findFile(bmd);
            const bmtFile = rarc.findFile(bmt);
            const bmdModel = lookupModel(bmdFile, bmtFile);
            const modelInstance = new BMDModelInstance(device, renderHelper, textureHolder, bmdModel);
            modelInstance.passMask = SMSPass.OPAQUE;
            return new BMDObjectRenderer(modelInstance);
        }

        function bckm(bmdFilename: string, bckFilename: string, loopMode: LoopMode = LoopMode.REPEAT): BMDObjectRenderer {
            const bmdFile = rarc.findFile(bmdFilename);
            const bmdModel = lookupModel(bmdFile, null);
            const modelInstance = new BMDModelInstance(device, renderHelper, textureHolder, bmdModel);
            modelInstance.passMask = SMSPass.OPAQUE;
            const bckFile = rarc.findFile(bckFilename);
            const bck = BCK.parse(bckFile.buffer);
            bck.ank1.loopMode = loopMode;
            modelInstance.bindANK1(bck.ank1);
            return new BMDObjectRenderer(modelInstance);
        }

        function basenameModel(basename: string): BMDObjectRenderer | null {
            const bmdFile = rarc.findFile(`${basename}.bmd`);
            if (!bmdFile)
                return null;
            const btkFile = rarc.findFile(`${basename}.btk`);
            const brkFile = rarc.findFile(`${basename}.brk`);
            const bckFile = rarc.findFile(`${basename}.bck`);
            const bmtFile = rarc.findFile(`${basename}.bmt`);

            const bmdModel = lookupModel(bmdFile, bmtFile);
            const modelInstance = new BMDModelInstance(device, renderHelper, textureHolder, bmdModel);
            modelInstance.passMask = SMSPass.OPAQUE;

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

            modelInstance.name = basename;
            return new BMDObjectRenderer(modelInstance);
        }
        const colors: Color[] = [
            new Color(0.2, 1.0, 1.0, 0.0), //light blue
            new Color(0.0, 0.0, 0.9, 0.0), //blue
            new Color(1.0, 0.9, 0.0, 0.0), //yellow
            new Color(0.8, 0.4, 0.2, 0.0), //light brown
            new Color(1.0, 0.0, 1.0, 0.0), //purple
            new Color(1.0, 0.0, 0.0, 0.0),
            new Color(0.0, 0.0, 0.6, 0.0), //dark blue
            new Color(1.0, 0.6, 0.2, 0.0), //orange
            new Color(0.0, 0.0, 0.8, 0.0), //dark blue
            new Color(1.0, 0.7, 0.4, 0.0), //light orange
            new Color(0.0, 1.0, 0.0, 0.0), //green
            new Color(0.0, 0.0, 0.0, 0.0),
        ];

        const colors2: Color[] = [
            new Color(0.2, 1.0, 1.0, 0.0), //light blue
            new Color(1.0, 0.6, 0.2, 0.0), //blue
            new Color(1.0, 0.9, 0.0, 0.0), //yellow
            new Color(0.8, 0.4, 0.2, 0.0), //light brown
            new Color(1.0, 0.0, 0.0, 0.0), //purple
            new Color(1.0, 0.0, 0.0, 0.0),
            new Color(0.0, 0.0, 0.6, 0.0), //dark blue
            new Color(1.0, 0.6, 0.2, 0.0), //orange
            new Color(0.0, 0.0, 0.8, 0.0), //dark blue
            new Color(1.0, 0.7, 0.4, 0.0), //light orange
            new Color(0.0, 1.0, 0.0, 0.0), //green
            new Color(0.0, 0.0, 0.0, 0.0),
        ];

        const modelLookup: ModelLookup[] = [
            { k: 'BananaTree', m: 'BananaTree', p: 'mapobj/bananatree' },
            { k: 'Bathtub', m: 'bath', p: 'mapobj/bath'},
            { k: 'BellDolpicPolice', m: 'belldolpic', p: 'mapobj/BellDolpic'},            
            { k: 'BellDolpicTV', m: 'belldolpic', p: 'mapobj/BellDolpic'},  
            { k: 'BiaBell', m: 'BiaBell', s: () => bmtm('mapobj/BiaBell.bmd', 'mapobj/bianco.bmt') },  
            { k: 'BiaTurnBridge', m: 'BiaTurnBridge', s: () => bmtm('mapobj/biaturnbridge.bmd', 'mapobj/bianco.bmt') },
            { k: 'BiaWatermill', m: 'BiaWatermill', s: () => bmtm('mapobj/biawatermill.bmd', 'mapobj/bianco.bmt') },
            { k: 'BiaWatermillVertical', m: 'BiaWatermillVertical', s: () => bmtm('mapobj/biawatermillvertical.bmd', 'mapobj/bianco.bmt') },
            { k: 'BigWindmill', m: 'bigWindmill', s: () => bmtm('mapobj/bigwindmill.bmd', 'mapobj/bianco.bmt') },
            { k: 'BrickBlock', m: 'BrickBlock', p: 'mapobj/brickblock' },
            { k: 'Coin', m: 'coin', p: 'mapobj/coin' },
            { k: 'Coin', m: 'invisible_coin', p: 'mapobj/coin' },
            { k: 'Coin', m: 'invisible_coin', p: 'mapobj/coin' },
            { k: 'CoinRed', m: 'coin_red', p: 'mapobj/coin_red' },
            { k: 'CoinBlue', m: 'coin_blue', p: 'mapobj/coin_blue' },
            { k: 'craneUpDown', m: 'craneUpDown', p: 'mapobj/craneUpDown' },
            { k: 'CraneRotY', m: 'crane', p: 'mapobj/crane' },
            { k: 'DolWeathercock', m: 'dptWeathercock', p: 'mapobj/dptweathercock' },
            { k: 'Fence', m: 'fence_normal', p: 'mapobj/fence_normal' },
            { k: 'Fence', m: 'fence3x3', p: 'mapobj/fence_half' },
            { k: 'FenceRevolve', m: 'fence_revolve', p: 'mapobj/fence_revolve_outer' },
            { k: 'FenceInner', m: 'fenceInnerGreen', p: 'mapobj/fenceinnergreen' },
            { k: 'FenceWaterH', m: 'FenceWaterH', p: 'mapobj/fencewaterh' },
            { k: 'FenceWaterV', m: 'FenceWaterV', p: 'mapobj/fencewaterv' },
            { k: 'FerrisWheel', m: 'FerrisWheel', p: 'mapobj/ferriswheel' },
            { k: 'FlowerCoin', m: 'coin', p: 'mapobj/coin' },
            { k: 'IceBlock', m: 'IceBlock', p: 'mapobj/iceblock' },
            { k: 'LeafBoat', m: 'LeafBoat', s: () => bmtm('mapobj/leafboat.bmd', 'mapobj/leafboat.bmt') },
            { k: 'LeanMirror', m: 'mirrorS', p: 'mapobj/mirrorS' },
            { k: 'LeanMirror', m: 'mirrorM', p: 'mapobj/mirrorM' },
            { k: 'LeanMirror', m: 'mirrorL', p: 'mapobj/mirrorL' },
            { k: 'NPCBoard', m: 'NPCBoard', p: 'boardnpc/boardnpc' },
            { k: 'Manhole', m: 'manhole', p: 'mapobj/manhole' },
            { k: 'MammaYacht', m: 'MammaYacht00', p: 'mapobj/mammayacht00' },
            { k: 'MapObjBase', m: 'DokanGate', p: 'mapobj/efdokangate' },
            { k: 'MapObjBase', m: 'ArrowBoardLR', s: () => bmtm('mapobj/arrowboardlr.bmd', 'mapobj/arrowboard.bmt') },
            { k: 'MapObjBase', m: 'ArrowBoardUp', s: () => bmtm('mapobj/arrowboardup.bmd', 'mapobj/arrowboard.bmt') },
            { k: 'MapObjBase', m: 'ArrowBoardDown', s: () => bmtm('mapobj/arrowboarddown.bmd', 'mapobj/arrowboard.bmt') },
            { k: 'MapObjBase', m: 'monte_chair', p: 'mapobj/monte_chair_model' },
            { k: 'MapObjGeneral', m: 'lampBianco', s: () => bmtm('mapobj/lampBianco.bmd',  'mapobj/bianco.bmt') },
            { k: 'MapObjGeneral', m: 'container', p: 'mapobj/container' },
            { k: 'MapObjRootPakkun', m: 'rootPaku', p: 'mapobj/rootPaku' },

            { k: 'MapStaticObj', m: 'ReflectSky', s: () => null },
            // Disable SeaIndirect loading...
            { k: 'MapStaticObj', m: 'SeaIndirect', s: () => null },
            { k: 'MapObjTreeScale', m: 'BananaTree', p: 'mapobj/bananatree' },            
            { k: 'Merrygoround', m: 'merry', p: 'mapobj/merry' },
            { k: 'MiniWindmill', m: 'MiniWindmillL', s: () => bmtm('mapobj/miniwindmilll.bmd', 'mapobj/bianco.bmt') },
            { k: 'MonumentShine', m: 'monumentshine', p: 'mapobj/monumentshine' },
            { k: 'NozzleBox', m: 'NozzleBox', p: 'mapobj/nozzlebox' },
            { k: 'Palm', m: 'palmNormal', p: 'mapobj/palmnormal' },
            { k: 'Palm', m: 'palmLeaf', p: 'mapobj/palmleaf' },
            { k: 'PalmNatume', m: 'palmNatume', p: 'mapobj/palmnatume' },
            { k: 'PalmOugi', m: 'palmOugi', p: 'mapobj/palmougi' },
            { k: 'PinnaDoor', m: 'PinnaDoor', p: 'mapobj/pinnadoor' },
            { k: 'ResetFruit', m: 'FruitBanana', p: 'mapobj/fruitbanana' },
            { k: 'ResetFruit', m: 'FruitCoconut', p: 'mapobj/fruitcoconut' },
            { k: 'ResetFruit', m: 'FruitDurian', p: 'mapobj/fruitdurian' },
            { k: 'ResetFruit', m: 'FruitPapaya', p: 'mapobj/fruitpapaya' },
            { k: 'ResetFruit', m: 'FruitPine', p: 'mapobj/fruitpine' },
            { k: 'ResetFruit', m: 'RedPepper', p: 'mapobj/redpepper' },
            { k: 'RiccoLog', m: 'riccoLog', p: 'mapobj/riccolog' },
            { k: 'riccoWatermill', m: 'riccoWatermill', p: 'mapobj/riccoWatermill' },
            { k: 'ShellCup', m: 'ShellCup', p: 'mapobj/shellcup' },
            { k: 'SandBombBase', m: 'SandBombBaseMushroom', s: () => bmtm('mapobj/sandbombbasemushroom.bmd', 'mapobj/sandbombbase.bmt') },
            { k: 'SandBombBase', m: 'SandBombBasePyramid', s: () => bmtm('mapobj/sandbombbasepyramid.bmd', 'mapobj/sandbombbase.bmt') },
            { k: 'SandBombBase', m: 'SandBombBaseShit', s: () => bmtm('mapobj/sandbombbaseshit.bmd', 'mapobj/sandbombbase.bmt') },
            { k: 'SandBombBase', m: 'SandBombBaseStar', s: () => bmtm('mapobj/sandbombbasestar.bmd', 'mapobj/sandbombbase.bmt') },
            { k: 'SandBombBase', m: 'SandBombBaseTurtle', s: () => bmtm('mapobj/sandbombbaseturtle.bmd', 'mapobj/sandbombbase.bmt') },
            { k: 'SandBombBase', m: 'SandBombBaseFoot', s: () => bmtm('mapobj/sandbombbasefoot.bmd', 'mapobj/sandbombbase.bmt') },
            { k: 'SandBombBase', m: 'SandBombBaseStairs', s: () => bmtm('mapobj/sandbombbasestairs.bmd', 'mapobj/sandbombbase.bmt') },
            { k: 'SandEgg', m: 'SandEggNormal', p: 'mapobj/sandeggnormal' },
            { k: 'SunModel', m: 'SunModel', p: 'sun/model' },
            { k: 'TurboNozzleDoor', m: 'nozzleDoor', p: 'mapobj/nozzledoor' },
            { k: 'Viking', m: 'viking', p: 'mapobj/viking' },
            { k: 'WindmillRoof', m: 'WindmillRoof', p: 'mapobj/windmillroof'},
            { k: 'WoodBox', m: 'WoodBox', p: 'mapobj/kibako' },
            { k: 'WoodBarrel', m: 'wood_barrel', s: () => bmtm('mapobj/barrel_normal.bmd', 'mapobj/barrel.bmt') },
            { k: 'WoodBarrel', m: 'wood_barrel_once', s: () => bmtm('mapobj/barrel_normal.bmd', 'mapobj/barrel.bmt') },

            //Skeletal Models
            { k: 'Shine', m: 'shine', s: () => bckm('mapobj/shine.bmd', 'mapobj/shine_float.bck') },
            { k: 'FruitsBoat', m: 'FruitsBoat', s: () => bckm('fruitsboat/shipdolpic.bmd', 'fruitsboat/shipdolpic.bck')},
            { k: 'FruitsBoatB', m: 'FruitsBoat', s: () => bckm('fruitsboatb/shipdolpic2.bmd', 'fruitsboatb/shipdolpic2.bck')},
            { k: 'ShiningStone', m: 'ShiningStone', s: () => {
                const m = bckm('mapobj/shiningstonered.bmd', 'mapobj/shiningstonered.bck');
                const blue = bckm('mapobj/shiningstoneblue.bmd', 'mapobj/shiningstoneblue.bck');
                const green = bckm('mapobj/shiningstonegreen.bmd', 'mapobj/shiningstonegreen.bck');

                blue.setParentJoint(m, 'ShiningStoneRed');
                green.setParentJoint(m, 'ShiningStoneRed');
                return m;
            }},
            { k: 'RiccoSwitch', m: 'RiccoSwitch', s: () => bckm('mapobj/riccoswitch.bmd', 'mapobj/riccoswitch.bck') },
            { k: 'Amenbo', m: 'Amenbo', s: () => bckm('amenbo/amenbo_model1.bmd', 'amenbo/amenbo_wait1_loop.bck') }, 
            { k: 'BiaWatermill', m: 'BiaWatermill01', s: () => bmtm('mapobj/biawatermill01.bmd', 'mapobj/bianco.bmt') }, //Todo: Hook up animation as well as texture
            { k: 'SandCastle', m: 'SandCastle', s: () => bckm('mapobj/sandcastle.bmd', 'mapobj/sandcastle_up.bck') }, //Todo: Hook up bmt
            { k: 'SandBomb', m: 'SandBomb', s: () => bckm('mapobj/sandbomb.bmd', 'mapobj/sandbomb_wait.bck') }, //Todo: Hook up bmt

            //Wind Spirit
            { k: 'Kazekun', m: 'Kazekun', s: () => bckm('kazekun/kazekun.bmd', 'kazekun/kazekun_wait.bck') }, //Todo: Figure out wind body particle effect
            
            //Bowser
            { k: 'Koopa', m: 'Koopa', s: () => bckm('koopa/koopa_model.bmd', 'koopa/koopa_wait.bck') },

            //Bowser Jr.
            { k: 'KoopaJr', m: 'KoopaJr', s: () => bckm('koopajr/koopajr_model.bmd', 'koopajr/koopajr_wait.bck') },
            
            //Bloopers
            { k: 'BossGesso', m: 'BossGesso', s: () => bckm('bgeso/bgeso_body.bmd', 'bgeso/bgeso_wait.bck')},
            { k: 'Gesso', m: 'Gesso', s: () => bckm('rikugesso/geso_model1.bmd', 'rikugesso/geso_wait1.bck') },
            { k: 'LandGesso', m: 'LandGesso', s: () => bckm('rikugesso/geso_model1.bmd', 'rikugesso/geso_wait1.bck')},
            { k: 'MameGesso', m: 'MameGesso', s: () => bckm('mamegesso/default.bmd', 'mamegesso/mamegeso_wait1.bck')},
            
            //Pokey
            { k: 'SamboHead', m: 'SamboHead', s: () => bckm('sambohead/sambohead.bmd', 'sambohead/sambohead_wait.bck') },
            { k: 'SamboFlower', m: 'SamboFlower', s: () => bckm('samboflower/flower.bmd', 'samboflower/flower_wait.bck') },
            
            //Piranha Plants
            { k: 'BossPakkun', m: 'BossPakkun', s: () => bckm('bosspakkun/bosspaku_model.bmd', 'bosspakkun/bosspaku_wait.bck')},
            { k: 'KBossPakkun', m: 'KBossPakkun', s: () => bckm('kbosspakkun/bosspaku_model.bmd', 'kbosspakkun/bosspaku_wait.bck')},
            { k: 'StayPakkun', m: 'StayPakkun', s: () => bckm('pakkun/pakun.bmd', 'pakkun/pakun_wait.bck')},
            { k: 'GateKeeper', m: 'GateKeeper', s: () => bckm('gatekeeper/gene_pakkun_model1.bmd', 'gatekeeper/gene_pakkun_wait2.bck') }, //Todo: Figure out material
            
            //Cataquack
            { k: 'PoiHana', m: 'PoiHana', s: () => bckm('poihana/default.bmd', 'poihana/poihana_wait.bck') },
            { k: 'PoiHanaRed', m: 'PoiHanaRed', s: () => {
                const m = bckm('poihana/default.bmd', 'poihana/poihana_wait.bck');
                m.modelInstance.setColorOverride(ColorKind.C0, new Color(1, 0.2, 0.2, 0));
                return m;
            }},//Todo: Fix Color

            //Eel boss
            { k: 'BossEel', m: 'BossEel', s: () => bckm('bosseel/meoto_model.bmd', 'bosseel/meoto_paku.bck')},       

            //Cheep Cheep
            { k: 'TabePuku', m: 'TabePuku', s: () => bckm('tabepuku/tabepuku.bmd', 'tabepuku/pukupuku_swim.bck') },

            //Fish
            { k: 'FishoidA', m: 'FishoidA', s: () => bckm('fish/fisha.bmd', 'fish/fish_swim.bck')},
            { k: 'FishoidB', m: 'FishoidB', s: () => bckm('fish/fishb.bmd', 'fish/fish_swim.bck')},
            { k: 'FishoidC', m: 'FishoidC', s: () => bckm('fish/fishc.bmd', 'fish/fish_swim.bck')},
            { k: 'FishoidD', m: 'FishoidD', s: () => bckm('fish/fishd.bmd', 'fish/fish_swim.bck')},

            
            //Birds
            { k: 'AnimalBird', m: 'AnimalBird', s: () => {
                const m = bckm('bird/bird_man.bmd', 'bird/bird_fly.bck');
                obj.y += 35;
                return m;
            }},
            { k: 'AnimalMew', m: 'AnimalMew', s: () => bckm('mew/kamome_high.bmd', 'mew/kamome_kakku.bck') },

            //Il Piantissimo
            { k: 'EMario', m: 'EMario', p: 'map/map/pad/monteman_model' },

            //Noki Male
            { k: 'NPCMareM', m: 'NPCMareM', s: () => {
                const m = bckm('marem/marem.bmd', 'marem/marem_wait.bck');
                m.modelInstance.setColorOverride(ColorKind.C0, new Color(Math.random(),Math.random(),Math.random(),0));
                m.modelInstance.setColorOverride(ColorKind.C1, new Color(Math.random(),Math.random(),Math.random(),0));
                m.modelInstance.setColorOverride(ColorKind.C2, new Color(Math.random(),Math.random(),Math.random(),0));
                
                const shell = basenameModel('marem/maremmakigai_b');
                shell.setParentJoint(m, 'koshi');
                shell.modelInstance.setColorOverride(ColorKind.C0, new Color(Math.random(),Math.random(),Math.random(),0));
                shell.modelInstance.setColorOverride(ColorKind.C1, new Color(Math.random(),Math.random(),Math.random(),0));
                shell.modelInstance.setColorOverride(ColorKind.C2, new Color(Math.random(),Math.random(),Math.random(),0));
                
                return m;
            }},
            { k: 'NPCMareMC', m: 'NPCMareMC', s: () => {
                const m = bckm('marem/marem.bmd', 'marem/marem_wait.bck');
                m.modelInstance.setColorOverride(ColorKind.C0, new Color(Math.random(),Math.random(),Math.random(),0));
                m.modelInstance.setColorOverride(ColorKind.C1, new Color(Math.random(),Math.random(),Math.random(),0));
                m.modelInstance.setColorOverride(ColorKind.C2, new Color(Math.random(),Math.random(),Math.random(),0));
                
                const shell = basenameModel('maremc/maremcagohige');
                shell.setParentJoint(m, 'koshi');
                shell.modelInstance.setColorOverride(ColorKind.C0, new Color(Math.random(),Math.random(),Math.random(),0));
                shell.modelInstance.setColorOverride(ColorKind.C1, new Color(Math.random(),Math.random(),Math.random(),0));
                shell.modelInstance.setColorOverride(ColorKind.C2, new Color(Math.random(),Math.random(),Math.random(),0));
                return m;
            }},
            { k: 'NPCMareMD', m: 'NPCMareMD', s: () => {
                const m = bckm('marem/marem.bmd', 'marem/marem_wait.bck');
                m.modelInstance.setColorOverride(ColorKind.C0, new Color(Math.random(),Math.random(),Math.random(),0));
                m.modelInstance.setColorOverride(ColorKind.C1, new Color(Math.random(),Math.random(),Math.random(),0));
                m.modelInstance.setColorOverride(ColorKind.C2, new Color(Math.random(),Math.random(),Math.random(),0));
                
                const shell = basenameModel('maremd/maremdhoragai_a');
                shell.setParentJoint(m, 'koshi');
                shell.modelInstance.setColorOverride(ColorKind.C0, new Color(Math.random(),Math.random(),Math.random(),0));
                shell.modelInstance.setColorOverride(ColorKind.C1, new Color(Math.random(),Math.random(),Math.random(),0));
                shell.modelInstance.setColorOverride(ColorKind.C2, new Color(Math.random(),Math.random(),Math.random(),0));
                return m;
            }},

            //Noki Female
            { k: 'NPCMareW', m: 'NPCMareW', s: () => {
                const m = bckm('marew/marew.bmd', 'marew/marew_wait.bck');
                m.modelInstance.setColorOverride(ColorKind.C0, new Color(Math.random(),Math.random(),Math.random(),0));
                m.modelInstance.setColorOverride(ColorKind.C1, new Color(Math.random(),Math.random(),Math.random(),0));
                m.modelInstance.setColorOverride(ColorKind.C2, new Color(Math.random(),Math.random(),Math.random(),0));
                
                const shell = basenameModel('marew/marewkai_b');
                shell.setParentJoint(m, 'koshi');
                shell.modelInstance.setColorOverride(ColorKind.C0, new Color(Math.random(),Math.random(),Math.random(),0));
                shell.modelInstance.setColorOverride(ColorKind.C1, new Color(Math.random(),Math.random(),Math.random(),0));
                shell.modelInstance.setColorOverride(ColorKind.C2, new Color(Math.random(),Math.random(),Math.random(),0));
                return m;
            }},


            //Pianta Male
            { k: 'NPCMonteM', m: 'NPCMonteM', s: () => {
                const m = bckm('montem/mom_model.bmd', 'montemcommon/mom_wait.bck');

                textureHolder.addBTITexture(device, BTI.parse(rarc.findFile(`montemcommon/i_mom_mino_rgba.bti`).buffer, `i_mom_mino_rgba`));
                const monteTexture = textureHolder.gfxTextures.find(tex =>tex.ResourceName === 'i_mom_mino_rgba');
                const textureOverride: TextureOverride = { gfxTexture: monteTexture, width: EFB_WIDTH, height: EFB_HEIGHT, flipY: true };
                textureHolder.setTextureOverride("I_mom_mino_dummyI4", textureOverride, false);
                m.modelInstance.setColorOverride(ColorKind.C0, colors[obj.bodyColor]);
                m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.shirtColor]);
                //m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.accessoryColor]);

                return m;
            }},
            { k: 'NPCMonteMA', m: 'NPCMonteMA', s: () => {
                const m = bckm('montema/moma_model.bmd', 'montemcommon/mom_wait.bck');

                textureHolder.addBTITexture(device, BTI.parse(rarc.findFile(`montemcommon/i_mom_mino_rgba.bti`).buffer, `i_mom_mino_rgba`));
                const monteTexture = textureHolder.gfxTextures.find(tex =>tex.ResourceName === 'i_mom_mino_rgba');
                const textureOverride: TextureOverride = { gfxTexture: monteTexture, width: EFB_WIDTH, height: EFB_HEIGHT, flipY: true };
                textureHolder.setTextureOverride("I_mom_mino_dummyI4", textureOverride, false);
                m.modelInstance.setColorOverride(ColorKind.C0, colors[obj.bodyColor]);
                m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.shirtColor]);
                //m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.accessoryColor]);

                return m;
            }},
            { k: 'NPCMonteMB', m: 'NPCMonteMB', s: () => {
                const m = bckm('montemb/momb_model.bmd', 'montemcommon/mom_wait.bck');

                textureHolder.addBTITexture(device, BTI.parse(rarc.findFile(`montemcommon/i_mom_mino_rgba.bti`).buffer, `i_mom_mino_rgba`));
                const monteTexture = textureHolder.gfxTextures.find(tex =>tex.ResourceName === 'i_mom_mino_rgba');
                const textureOverride: TextureOverride = { gfxTexture: monteTexture, width: EFB_WIDTH, height: EFB_HEIGHT, flipY: true };
                textureHolder.setTextureOverride("I_mom_mino_dummyI4", textureOverride, false);
                m.modelInstance.setColorOverride(ColorKind.C0, colors[obj.bodyColor]);
                m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.shirtColor]);
                //m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.accessoryColor]);

                return m;
            }},
            { k: 'NPCMonteMC', m: 'NPCMonteMC', s: () => {
                const m = bckm('montemc/momc_model.bmd', 'montemcommon/mom_wait.bck');

                textureHolder.addBTITexture(device, BTI.parse(rarc.findFile(`montemcommon/i_mom_mino_rgba.bti`).buffer, `i_mom_mino_rgba`));
                const monteTexture = textureHolder.gfxTextures.find(tex =>tex.ResourceName === 'i_mom_mino_rgba');
                const textureOverride: TextureOverride = { gfxTexture: monteTexture, width: EFB_WIDTH, height: EFB_HEIGHT, flipY: true };
                textureHolder.setTextureOverride("I_mom_mino_dummyI4", textureOverride, false);
                m.modelInstance.setColorOverride(ColorKind.C0, colors[obj.bodyColor]);
                m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.shirtColor]);
                //m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.accessoryColor]);

                return m;
            }},
            { k: 'NPCMonteMD', m: 'NPCMonteMD', s: () => 
            {
                const m = bckm('montemd/momd_model.bmd', 'montemcommon/mom_wait.bck');

                textureHolder.addBTITexture(device, BTI.parse(rarc.findFile(`montemcommon/i_mom_mino_rgba.bti`).buffer, `i_mom_mino_rgba`));
                m.modelInstance.setColorOverride(ColorKind.C0, colors[obj.bodyColor]);
                m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.shirtColor]);
                //m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.accessoryColor]);
                return m;
            }},
            { k: 'NPCMonteME', m: 'NPCMonteME', s: () => bckm('monteme/mome_model.bmd', 'monteme/mome_wait.bck') },
            { k: 'NPCMonteMH', m: 'NPCMonteMH', s: () => 
            {
                const m = bckm('montema/moma_model.bmd', 'montemh/momh_play.bck');
                m.modelInstance.setColorOverride(ColorKind.C0, colors[obj.bodyColor]);
                m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.shirtColor]);
                //m.modelInstance.setColorOverride(ColorKind.C2, colors[obj.accessoryColor]);

                const uke = basenameModel('montemh/uklele_model');
                uke.setParentJoint(m, 'body_jnt');
                return m;
            }},

            //Pianta Female
            { k: 'NPCMonteW', m: 'NPCMonteW', s: () => {
                const m = bckm('montew/mow_model.bmd', 'montewcommon/mow_wait.bck');
                textureHolder.addBTITexture(device, BTI.parse(rarc.findFile(`montewcommon/i_mow_mino_rgba.bti`).buffer, `i_mow_mino_rgba`));
                const monteTexture = textureHolder.gfxTextures.find(tex =>tex.ResourceName === 'i_mow_mino_rgba');
                const textureOverride: TextureOverride = { gfxTexture: monteTexture, width: EFB_WIDTH, height: EFB_HEIGHT, flipY: true };
                textureHolder.setTextureOverride("I_mow_mino_dummyI4", textureOverride, false);
                m.modelInstance.setColorOverride(ColorKind.C0, colors2[obj.bodyColor]);
                return m;
            }},
            { k: 'NPCMonteWB', m: 'NPCMonteWB', s: () => {
                const m = bckm('montewb/mowb_model.bmd', 'montewcommon/mow_wait.bck');
                textureHolder.addBTITexture(device, BTI.parse(rarc.findFile(`montewcommon/i_mow_mino_rgba.bti`).buffer, `i_mow_mino_rgba`));
                const monteTexture = textureHolder.gfxTextures.find(tex =>tex.ResourceName === 'i_mow_mino_rgba');
                const textureOverride: TextureOverride = { gfxTexture: monteTexture, width: EFB_WIDTH, height: EFB_HEIGHT, flipY: true };
                textureHolder.setTextureOverride("I_mow_mino_dummyI4", textureOverride, false);
                m.modelInstance.setColorOverride(ColorKind.C0, colors2[obj.bodyColor]);
                return m;
            }},

            //Yoshi Egg
            { k: 'EggYoshi', m: 'EggYoshi', s: () => bckm('mapobj/eggyoshi_normal.bmd', 'mapobj/eggyoshi_wait.bck') },

            //Toadsworth
            { k: 'NPCKinojii', m: 'NPCKinojii', s: () => {
                const m = bckm('kinojii/kinoji_body.bmd', 'kinojii/kinoji_wait.bck');
                const stick = basenameModel('kinojii/kinoji_stick');
                stick.setParentJoint(m, 'jnt_rsum');
                return m;
            }},

            //Princess Peach
            { k: 'NPCPeach', m: 'NPCPeach', s: () => {
                const m = bckm('peach/peach_model.bmd', 'peach/peach_wait.bck');
                const ponytail = bckm('peach/peach_hair_ponytail.bmd', 'peach/peach_hair_ponytail_wait.bck');
                ponytail.setParentJoint(m, 'kubi');
                const hand1l = basenameModel('peach/peach_hand2_l');
                hand1l.setParentJoint(m, 'jnt_hand_L');
                const hand1r = basenameModel('peach/peach_hand2_r');
                hand1r.setParentJoint(m, 'jnt_hand_R');
                return m;
            }},
            { k: 'BathtubPeach', m: 'BathtubPeach', s: () => {
                const m = bckm('bathtubpeach/peach_model.bmd', 'bathtubpeach/peach_wait.bck');
                const ponytail = bckm('bathtubpeach/peach_hair_ponytail.bmd', 'bathtubpeach/peach_hair_ponytail_wait.bck');
                ponytail.setParentJoint(m, 'kubi');
                const hand1l = basenameModel('bathtubpeach/peach_hand2_l');
                hand1l.setParentJoint(m, 'jnt_hand_L');
                const hand1r = basenameModel('bathtubpeach/peach_hand2_r');
                hand1r.setParentJoint(m, 'jnt_hand_R');
                return m;
            }}, //Todo: Fix Peach hands

            //Toad
            { k: 'NPCKinopio', m: 'NPCKinopio', s: () => {
                const m = bckm('kinopio/kinopio_body.bmd', 'kinopio/kinopio_wait.bck');
                m.modelInstance.setColorOverride(ColorKind.C1, new Color(Math.random(),Math.random(),Math.random(),0));
                m.modelInstance.setColorOverride(ColorKind.C2, new Color(Math.random(),Math.random(),Math.random(),0));
                return m;
            }},
        ];

        let modelEntry = modelLookup.find((lt) => obj.klass === lt.k && obj.model === lt.m);
        if (modelEntry === undefined) {
            // Load heuristics -- maybe should be explicit...
            let prefix;
            if (obj.klass === 'MapStaticObj') {
                prefix = `map/map/${obj.model.toLowerCase()}`;
            } else if (obj.klass === 'MapObjBase') {
                prefix = `mapobj/${obj.model.toLowerCase()}`;
            }

            if (prefix) {
                const file = rarc.findFile(`${prefix}.bmd`);
                if (file)
                    modelEntry = { k: obj.klass, m: obj.model, p: prefix };
            }
        }

        if (modelEntry === undefined) {
            console.warn(`No model for ${obj.klass} ${obj.model}`);
            return null;
        }

        let scene = null;
        if (modelEntry.p !== undefined) {
            scene = basenameModel(modelEntry.p);
        } else if (modelEntry.s !== undefined) {
            scene = modelEntry.s();
        }

        if (scene === null)
            return null;

        const q = quat.create();
        quat.fromEuler(q, obj.rotationX, obj.rotationY, obj.rotationZ);
        mat4.fromRotationTranslationScale(scene.modelMatrix, q, [obj.x, obj.y, obj.z], [obj.scaleX, obj.scaleY, obj.scaleZ]);
        return scene;
    }
}

const id = "sms";
const name = "Super Mario Sunshine";

const sceneDescs = [
    "Main Scenes",
    new SunshineSceneDesc("dolpic0", "Delfino Plaza"),
    new SunshineSceneDesc("airport0", "Delfino Airport"),
    new SunshineSceneDesc("bianco0", "Bianco Hills"),
    new SunshineSceneDesc("ricco0", "Ricco Harbor"),
    new SunshineSceneDesc("mamma0", "Gelato Beach"),
    new SunshineSceneDesc("pinnaBeach0", "Pinna Park Beach"),
    new SunshineSceneDesc("pinnaParco0", "Pinna Park"),
    new SunshineSceneDesc("sirena0", "Sirena Beach"),
    new SunshineSceneDesc("delfino0", "Delfino Hotel"),
    new SunshineSceneDesc("mare0", "Noki Bay"),
    new SunshineSceneDesc("monte3", "Pianta Village"),
    "Variations",
    new SunshineSceneDesc("airport0", "airport0"),
    new SunshineSceneDesc("airport1", "airport1"),
    new SunshineSceneDesc("bia_ex1", "bia_ex1"),
    new SunshineSceneDesc("bianco0", "bianco0"),
    new SunshineSceneDesc("bianco1", "bianco1"),
    new SunshineSceneDesc("bianco2", "bianco2"),
    new SunshineSceneDesc("bianco3", "bianco3"),
    new SunshineSceneDesc("bianco4", "bianco4"),
    new SunshineSceneDesc("bianco5", "bianco5"),
    new SunshineSceneDesc("bianco6", "bianco6"),
    new SunshineSceneDesc("bianco7", "bianco7"),
    new SunshineSceneDesc("biancoBoss", "biancoBoss"),
    new SunshineSceneDesc("casino0", "casino0"),
    new SunshineSceneDesc("casino1", "casino1"),
    new SunshineSceneDesc("coro_ex0", "coro_ex0"),
    new SunshineSceneDesc("coro_ex1", "coro_ex1"),
    new SunshineSceneDesc("coro_ex2", "coro_ex2"),
    new SunshineSceneDesc("coro_ex4", "coro_ex4"),
    new SunshineSceneDesc("coro_ex5", "coro_ex5"),
    new SunshineSceneDesc("coro_ex6", "coro_ex6"),
    new SunshineSceneDesc("coronaBoss", "coronaBoss"),
    new SunshineSceneDesc("delfino0", "delfino0"),
    new SunshineSceneDesc("delfino1", "delfino1"),
    new SunshineSceneDesc("delfino2", "delfino2"),
    new SunshineSceneDesc("delfino3", "delfino3"),
    new SunshineSceneDesc("delfino4", "delfino4"),
    new SunshineSceneDesc("delfinoBoss", "delfinoBoss"),
    new SunshineSceneDesc("dolpic_ex0", "dolpic_ex0"),
    new SunshineSceneDesc("dolpic_ex1", "dolpic_ex1"),
    new SunshineSceneDesc("dolpic_ex2", "dolpic_ex2"),
    new SunshineSceneDesc("dolpic_ex3", "dolpic_ex3"),
    new SunshineSceneDesc("dolpic_ex4", "dolpic_ex4"),
    new SunshineSceneDesc("dolpic0", "dolpic0"),
    new SunshineSceneDesc("dolpic1", "dolpic1"),
    new SunshineSceneDesc("dolpic10", "dolpic10"),
    new SunshineSceneDesc("dolpic5", "dolpic5"),
    new SunshineSceneDesc("dolpic6", "dolpic6"),
    new SunshineSceneDesc("dolpic7", "dolpic7"),
    new SunshineSceneDesc("dolpic8", "dolpic8"),
    new SunshineSceneDesc("dolpic9", "dolpic9"),
    new SunshineSceneDesc("mam_ex0", "mam_ex0"),
    new SunshineSceneDesc("mam_ex1", "mam_ex1"),
    new SunshineSceneDesc("mamma0", "mamma0"),
    new SunshineSceneDesc("mamma1", "mamma1"),
    new SunshineSceneDesc("mamma2", "mamma2"),
    new SunshineSceneDesc("mamma3", "mamma3"),
    new SunshineSceneDesc("mamma4", "mamma4"),
    new SunshineSceneDesc("mamma5", "mamma5"),
    new SunshineSceneDesc("mamma6", "mamma6"),
    new SunshineSceneDesc("mamma7", "mamma7"),
    new SunshineSceneDesc("mare_ex0", "mare_ex0"),
    new SunshineSceneDesc("mare0", "mare0"),
    new SunshineSceneDesc("mare1", "mare1"),
    new SunshineSceneDesc("mare2", "mare2"),
    new SunshineSceneDesc("mare3", "mare3"),
    new SunshineSceneDesc("mare4", "mare4"),
    new SunshineSceneDesc("mare5", "mare5"),
    new SunshineSceneDesc("mare6", "mare6"),
    new SunshineSceneDesc("mare7", "mare7"),
    new SunshineSceneDesc("mareBoss", "mareBoss"),
    new SunshineSceneDesc("mareUndersea", "mareUndersea"),
    new SunshineSceneDesc("monte_ex0", "monte_ex0"),
    new SunshineSceneDesc("monte0", "monte0"),
    new SunshineSceneDesc("monte1", "monte1"),
    new SunshineSceneDesc("monte2", "monte2"),
    new SunshineSceneDesc("monte3", "monte3"),
    new SunshineSceneDesc("monte4", "monte4"),
    new SunshineSceneDesc("monte5", "monte5"),
    new SunshineSceneDesc("monte6", "monte6"),
    new SunshineSceneDesc("monte7", "monte7"),
    new SunshineSceneDesc("option", "option"),
    new SunshineSceneDesc("pinnaBeach0", "pinnaBeach0"),
    new SunshineSceneDesc("pinnaBeach1", "pinnaBeach1"),
    new SunshineSceneDesc("pinnaBeach2", "pinnaBeach2"),
    new SunshineSceneDesc("pinnaBeach3", "pinnaBeach3"),
    new SunshineSceneDesc("pinnaBeach4", "pinnaBeach4"),
    new SunshineSceneDesc("pinnaBoss0", "pinnaBoss0"),
    new SunshineSceneDesc("pinnaBoss1", "pinnaBoss1"),
    new SunshineSceneDesc("pinnaParco0", "pinnaParco0"),
    new SunshineSceneDesc("pinnaParco1", "pinnaParco1"),
    new SunshineSceneDesc("pinnaParco2", "pinnaParco2"),
    new SunshineSceneDesc("pinnaParco3", "pinnaParco3"),
    new SunshineSceneDesc("pinnaParco4", "pinnaParco4"),
    new SunshineSceneDesc("pinnaParco5", "pinnaParco5"),
    new SunshineSceneDesc("pinnaParco6", "pinnaParco6"),
    new SunshineSceneDesc("pinnaParco7", "pinnaParco7"),
    new SunshineSceneDesc("ricco0", "ricco0"),
    new SunshineSceneDesc("ricco1", "ricco1"),
    new SunshineSceneDesc("ricco2", "ricco2"),
    new SunshineSceneDesc("ricco3", "ricco3"),
    new SunshineSceneDesc("ricco4", "ricco4"),
    new SunshineSceneDesc("ricco5", "ricco5"),
    new SunshineSceneDesc("ricco6", "ricco6"),
    new SunshineSceneDesc("ricco7", "ricco7"),
    new SunshineSceneDesc("ricco8", "ricco8"),
    new SunshineSceneDesc("rico_ex0", "rico_ex0"),
    new SunshineSceneDesc("rico_ex1", "rico_ex1"),
    new SunshineSceneDesc("sirena_ex0", "sirena_ex0"),
    new SunshineSceneDesc("sirena_ex1", "sirena_ex1"),
    new SunshineSceneDesc("sirena0", "sirena0"),
    new SunshineSceneDesc("sirena1", "sirena1"),
    new SunshineSceneDesc("sirena2", "sirena2"),
    new SunshineSceneDesc("sirena3", "sirena3"),
    new SunshineSceneDesc("sirena4", "sirena4"),
    new SunshineSceneDesc("sirena5", "sirena5"),
    new SunshineSceneDesc("sirena6", "sirena6"),
    new SunshineSceneDesc("sirena7", "sirena7"),
    new SunshineSceneDesc("test11", "test11"),
];

// Backwards compatibility
const sceneIdMap = new Map<string, string>();
sceneIdMap.set("Delfino Plaza", "dolpic0");
sceneIdMap.set("Delfino Airport", "airport0");
sceneIdMap.set("Bianco Hills", "bianco0");
sceneIdMap.set("Ricco Harbor", "ricco0");
sceneIdMap.set("Gelato Beach", "mamma0");
sceneIdMap.set("Pinna Park Beach", "pinnaBeach0");
sceneIdMap.set("Pinna Park", "pinnaParco0");
sceneIdMap.set("Sirena Beach", "sirena0");
sceneIdMap.set("Delfino Hotel", "delfino0");
sceneIdMap.set("Noki Bay", "mare0");
sceneIdMap.set("Pianta Village", "monte3");

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs, sceneIdMap };
