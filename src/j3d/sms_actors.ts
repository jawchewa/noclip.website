
import * as Viewer from '../viewer';
import { mat4, vec3 } from "gl-matrix";
import { BMDModelInstance } from "./render";
import { ANK1, TTK1, TRK1 } from "./j3d";
import AnimationController from "../AnimationController";
import { GXRenderHelperGfx } from "../gx/gx_render";
import { AABB } from '../Geometry';
import { ScreenSpaceProjection, computeScreenSpaceProjectionFromWorldSpaceAABB, computeViewMatrix } from '../Camera';
import { GfxDevice } from '../gfx/platform/GfxPlatform';
import ArrayBufferSlice from '../ArrayBufferSlice';
import * as GX_Material from '../gx/gx_material';

// Special-case actors

export interface ObjectRenderer {
    prepareToRender(renderHelper: GXRenderHelperGfx, viewerInput: Viewer.ViewerRenderInput, visible: boolean): void;
    destroy(device: GfxDevice): void;
}

const scratchLight = new GX_Material.Light();
const bboxScratch = new AABB();
const screenProjection = new ScreenSpaceProjection();
export class BMDObjectRenderer implements ObjectRenderer {
    public visible = true;
    public modelMatrix: mat4 = mat4.create();

    private childObjects: BMDObjectRenderer[] = [];
    private parentJointMatrix: mat4 | null = null;

    constructor(public modelInstance: BMDModelInstance) {
    }

    public bindANK1(ank1: ANK1, animationController?: AnimationController): void {
        this.modelInstance.bindANK1(ank1, animationController);
    }

    public bindTTK1(ttk1: TTK1, animationController?: AnimationController): void {
        this.modelInstance.bindTTK1(ttk1, animationController);
    }

    public bindTRK1(trk1: TRK1, animationController?: AnimationController): void {
        this.modelInstance.bindTRK1(trk1, animationController);
    }

    public setParentJoint(o: BMDObjectRenderer, jointName: string): void {
        this.parentJointMatrix = o.modelInstance.getJointMatrixReference(jointName);
        o.childObjects.push(this);
    }

    public setMaterialColorWriteEnabled(materialName: string, v: boolean): void {
        this.modelInstance.setMaterialColorWriteEnabled(materialName, v);
    }

    public setVertexColorsEnabled(v: boolean): void {
        this.modelInstance.setVertexColorsEnabled(v);
        this.childObjects.forEach((child)=> child.setVertexColorsEnabled(v));
    }

    public setTexturesEnabled(v: boolean): void {
        this.modelInstance.setTexturesEnabled(v);
        this.childObjects.forEach((child)=> child.setTexturesEnabled(v));
    }

    public prepareToRender(renderHelper: GXRenderHelperGfx, viewerInput: Viewer.ViewerRenderInput, visible: boolean): void {
        this.modelInstance.visible = visible && this.visible;

        if (this.modelInstance.visible) {
            if (this.parentJointMatrix !== null) {
                mat4.mul(this.modelInstance.modelMatrix, this.parentJointMatrix, this.modelMatrix);
            } else {
                mat4.copy(this.modelInstance.modelMatrix, this.modelMatrix);

                // Don't compute screen area culling on child meshes (don't want heads to disappear before bodies.)
                bboxScratch.transform(this.modelInstance.bmdModel.bbox, this.modelInstance.modelMatrix);
                computeScreenSpaceProjectionFromWorldSpaceAABB(screenProjection, viewerInput.camera, bboxScratch);

                if (screenProjection.getScreenArea() <= 0.0002)
                    this.modelInstance.visible = false;
            }
        }

        GX_Material.lightSetWorldPosition(scratchLight, viewerInput.camera, 250, 250, 250);
        GX_Material.lightSetWorldDirection(scratchLight, viewerInput.camera, -250, -250, -250);
        // Toon lighting works by setting the color to red.
        scratchLight.Color.set(1, 1, 1, 0);
        vec3.set(scratchLight.CosAtten, 1.075, 0, 0);
        vec3.set(scratchLight.DistAtten, 1.075, 0, 0);
        this.modelInstance.setGXLight(0, scratchLight);

        this.modelInstance.prepareToRender(renderHelper, viewerInput);
        for (let i = 0; i < this.childObjects.length; i++)
            this.childObjects[i].prepareToRender(renderHelper, viewerInput, this.modelInstance.visible);
    }

    public destroy(device: GfxDevice): void {
        this.modelInstance.destroy(device);
        for (let i = 0; i < this.childObjects.length; i++)
            this.childObjects[i].destroy(device);
    }
}

export type SymbolData = { Filename: string, SymbolName: string, Data: ArrayBufferSlice };
export type SymbolMap = { SymbolData: SymbolData[] };