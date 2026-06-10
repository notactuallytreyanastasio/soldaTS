import type { Vec2 } from '../math/vec2';
export interface Constraint {
    active: boolean;
    partA: number;
    partB: number;
    restlength: number;
}
export declare class ParticleSystem {
    readonly active: boolean[];
    readonly posX: Float32Array<ArrayBuffer>;
    readonly posY: Float32Array<ArrayBuffer>;
    readonly velocityX: Float32Array<ArrayBuffer>;
    readonly velocityY: Float32Array<ArrayBuffer>;
    readonly oldX: Float32Array<ArrayBuffer>;
    readonly oldY: Float32Array<ArrayBuffer>;
    readonly forceX: Float32Array<ArrayBuffer>;
    readonly forceY: Float32Array<ArrayBuffer>;
    readonly oneOverMass: Float32Array<ArrayBuffer>;
    timeStep: number;
    gravity: number;
    vDamping: number;
    eDamping: number;
    constraintCount: number;
    partCount: number;
    readonly constraints: Constraint[];
    doEulerTimeStep(): void;
    doEulerTimeStepFor(i: number): void;
    doVerletTimeStep(): void;
    doVerletTimeStepFor(i: number, j: number): void;
    private euler;
    private verlet;
    satisfyConstraints(): void;
    satisfyConstraintsFor(i: number): void;
    createPart(start: Vec2, vel: Vec2, mass: number, num: number): void;
    makeConstraint(pa: number, pb: number, rest: number): void;
    stopAllParts(): void;
    destroy(): void;
}
//# sourceMappingURL=particles.d.ts.map