/**
 * Particle & constraint physics — port of `shared/Parts.pas` (PARTS ver. 1.0.7,
 * "PARTICLE & CONSTRAINT PHYSICS MODULE" by Michal Marcinkowski).
 *
 * This is the feel core: every Soldat body, bullet, spark and flag is a
 * `ParticleSystem`. Sprites are integrated with the Euler step
 * (`DoEulerTimeStepFor`, see tick-pipeline.md:189) and held together by the
 * skeleton's distance constraints (`SatisfyConstraints`).
 *
 * Layout note (port deviation, NOT a behaviour change): Pascal stores the
 * particles as arrays of `TVector2` records, 1-indexed `[1..NUM_PARTICLES]`.
 * We use a Struct-of-Arrays of `Float32Array` for cache friendliness and so
 * STRICT_F32 storage is exact, sized `NUM_PARTICLES + 1` so index 0 is unused
 * and the original 1-indexing is preserved verbatim. The arithmetic and field
 * names are a faithful mirror of Parts.pas.
 *
 * Every arithmetic result is wrapped in `f()` so the math carries Pascal
 * `Single` semantics under the golden master (STRICT_F32) and is plain f64 in
 * production. Vec2 math reuses the shared `math/vec2` helpers (which already
 * wrap in `f()`); the SoA stores are `Float32Array`, an exact f32 boundary.
 */
import { f } from '../scalar';
import { NUM_PARTICLES } from '../constants';
export class ParticleSystem {
    // PORT: shared/Parts.pas:42-52 — ParticleSystem object fields.
    // SoA, length NUM_PARTICLES+1 so slot 0 is dead and [1..NUM_PARTICLES] is valid.
    active = new Array(NUM_PARTICLES + 1).fill(false);
    posX = new Float32Array(NUM_PARTICLES + 1);
    posY = new Float32Array(NUM_PARTICLES + 1);
    velocityX = new Float32Array(NUM_PARTICLES + 1);
    velocityY = new Float32Array(NUM_PARTICLES + 1);
    oldX = new Float32Array(NUM_PARTICLES + 1);
    oldY = new Float32Array(NUM_PARTICLES + 1);
    forceX = new Float32Array(NUM_PARTICLES + 1);
    forceY = new Float32Array(NUM_PARTICLES + 1);
    oneOverMass = new Float32Array(NUM_PARTICLES + 1);
    // PORT: shared/Parts.pas:48-49 — scalar tuning fields.
    // Defaults mirror a fresh Pascal `object` (zeroed). Callers configure these:
    //   Sprite skeleton: TimeStep=1, Gravity=1.06*GRAV, VDamping=0.9945
    //   (shared/mechanics/Sprites.pas:326-329). RKV (0.98, Parts.pas:32) is the
    //   conventional velocity-damping value used by spark/body systems.
    timeStep = 0;
    gravity = 0;
    vDamping = 0; // Verlet position damping (1.0 + VDamping / VDamping blend)
    eDamping = 0; // Euler velocity damping (multiplies velocity each step)
    // PORT: shared/Parts.pas:50-52 — constraint bookkeeping.
    // Constraints are 1-indexed too: constraints[0] is a dead sentinel so that
    // ConstraintCount and the `[1..ConstraintCount]` loops match Pascal exactly.
    constraintCount = 0;
    partCount = 0;
    constraints = [
        { active: false, partA: 0, partB: 0, restlength: 0 }, // index 0 sentinel
    ];
    // PORT: shared/Parts.pas:97-104 — DoEulerTimeStep.
    doEulerTimeStep() {
        for (let i = 1; i <= NUM_PARTICLES; i++) {
            if (this.active[i]) {
                this.euler(i);
            }
        }
    }
    // PORT: shared/Parts.pas:92-95 — DoEulerTimeStepFor.
    doEulerTimeStepFor(i) {
        this.euler(i);
    }
    // PORT: shared/Parts.pas:76-84 — DoVerletTimeStep.
    doVerletTimeStep() {
        for (let i = 1; i <= NUM_PARTICLES; i++) {
            if (this.active[i]) {
                this.verlet(i);
            }
        }
        this.satisfyConstraints();
    }
    // PORT: shared/Parts.pas:86-90 — DoVerletTimeStepFor.
    doVerletTimeStepFor(i, j) {
        this.verlet(i);
        this.satisfyConstraintsFor(j);
    }
    // PORT: shared/Parts.pas:106-124 — Euler(I).
    //   Forces[I].Y := Forces[I].Y + Gravity;
    //   TempPos := Pos[I];
    //   Vec2Scale(S, Forces[I], OneOverMass[I]);
    //   Vec2Scale(S, S, Sqr(TimeStep));
    //   Velocity[I] := Vec2Add(Velocity[I], S);
    //   Pos[I] := Vec2Add(Pos[I], Velocity[I]);
    //   Vec2Scale(Velocity[I], Velocity[I], EDamping);
    //   OldPos[I] := TempPos;
    //   Forces[I] := 0;
    euler(i) {
        // Accumulate Forces (Parts.pas:111)
        this.forceY[i] = f(this.forceY[i] + this.gravity);
        const tempX = this.posX[i];
        const tempY = this.posY[i];
        // S := Forces[I] * OneOverMass[I] * Sqr(TimeStep)   (Parts.pas:114-115)
        const oom = this.oneOverMass[i];
        const sqrTs = f(this.timeStep * this.timeStep); // Sqr(TimeStep)
        let sX = f(this.forceX[i] * oom);
        let sY = f(this.forceY[i] * oom);
        sX = f(sX * sqrTs);
        sY = f(sY * sqrTs);
        // Velocity[I] := Velocity[I] + S   (Parts.pas:117)
        this.velocityX[i] = f(this.velocityX[i] + sX);
        this.velocityY[i] = f(this.velocityY[i] + sY);
        // Pos[I] := Pos[I] + Velocity[I]   (Parts.pas:118)
        this.posX[i] = f(tempX + this.velocityX[i]);
        this.posY[i] = f(tempY + this.velocityY[i]);
        // Velocity[I] := Velocity[I] * EDamping   (Parts.pas:119)
        this.velocityX[i] = f(this.velocityX[i] * this.eDamping);
        this.velocityY[i] = f(this.velocityY[i] * this.eDamping);
        // OldPos[I] := TempPos   (Parts.pas:120)
        this.oldX[i] = tempX;
        this.oldY[i] = tempY;
        // Forces[I] := 0   (Parts.pas:122-123)
        this.forceX[i] = 0;
        this.forceY[i] = 0;
    }
    // PORT: shared/Parts.pas:126-147 — Verlet(I).
    //   Forces[I].Y := Forces[I].Y + Gravity;
    //   TempPos := Pos[I];
    //   Vec2Scale(S1, Pos[I], 1.0 + VDamping);
    //   Vec2Scale(S2, OldPos[I], VDamping);
    //   D := Vec2Subtract(S1, S2);
    //   Vec2Scale(S1, Forces[I], OneOverMass[I]);
    //   Vec2Scale(S2, S1, Sqr(TimeStep));
    //   Pos[I] := Vec2Add(D, S2);
    //   OldPos[I] := TempPos;
    //   Forces[I] := 0;
    verlet(i) {
        // Accumulate Forces (Parts.pas:131)
        this.forceY[i] = f(this.forceY[i] + this.gravity);
        const tempX = this.posX[i];
        const tempY = this.posY[i];
        // S1 := Pos[I] * (1.0 + VDamping)   (Parts.pas:135)
        const posDamp = f(1.0 + this.vDamping);
        const s1X = f(this.posX[i] * posDamp);
        const s1Y = f(this.posY[i] * posDamp);
        // S2 := OldPos[I] * VDamping   (Parts.pas:136)
        const s2X = f(this.oldX[i] * this.vDamping);
        const s2Y = f(this.oldY[i] * this.vDamping);
        // D := S1 - S2   (Parts.pas:138)
        const dX = f(s1X - s2X);
        const dY = f(s1Y - s2Y);
        // S1 := Forces[I] * OneOverMass[I];  S2 := S1 * Sqr(TimeStep)  (Parts.pas:139-140)
        const oom = this.oneOverMass[i];
        const sqrTs = f(this.timeStep * this.timeStep);
        const fsX = f(f(this.forceX[i] * oom) * sqrTs);
        const fsY = f(f(this.forceY[i] * oom) * sqrTs);
        // Pos[I] := D + S2   (Parts.pas:142)
        this.posX[i] = f(dX + fsX);
        this.posY[i] = f(dY + fsY);
        // OldPos[I] := TempPos   (Parts.pas:143)
        this.oldX[i] = tempX;
        this.oldY[i] = tempY;
        // Forces[I] := 0   (Parts.pas:145-146)
        this.forceX[i] = 0;
        this.forceY[i] = 0;
    }
    // PORT: shared/Parts.pas:149-176 — SatisfyConstraints.
    satisfyConstraints() {
        if (this.constraintCount > 0) {
            for (let i = 1; i <= this.constraintCount; i++) {
                this.satisfyConstraintsFor(i);
            }
        }
    }
    // PORT: shared/Parts.pas:178-201 — SatisfyConstraintsFor(I).
    //   Delta := Pos[PartB] - Pos[PartA];
    //   Deltalength := Sqrt(Vec2Dot(Delta, Delta));
    //   if Deltalength <> 0 then Diff := (Deltalength - Restlength) / Deltalength;
    //   if OneOverMass[PartA] > 0 then Pos[PartA] := Pos[PartA] + Delta * 0.5 * Diff;
    //   if OneOverMass[PartB] > 0 then Pos[PartB] := Pos[PartB] - Delta * 0.5 * Diff;
    //
    // Note: the inactive-constraint guard (Parts.pas:158 `if Active`) lives in
    // SatisfyConstraints' loop in Pascal; SatisfyConstraintsFor itself does NOT
    // re-check Active (Parts.pas:183 `with Constraints[i]`). We mirror that: the
    // batch path checks Active here, the targeted `For` path does not.
    satisfyConstraintsFor(i) {
        const c = this.constraints[i];
        if (c === undefined) {
            return;
        }
        if (!c.active) {
            return; // SatisfyConstraints (batch) skips inactive constraints (Parts.pas:158)
        }
        const a = c.partA;
        const b = c.partB;
        // Delta := Pos[PartB] - Pos[PartA]   (Parts.pas:186)
        const deltaX = f(this.posX[b] - this.posX[a]);
        const deltaY = f(this.posY[b] - this.posY[a]);
        // Deltalength := Sqrt(Vec2Dot(Delta, Delta))   (Parts.pas:187)
        const dot = f(f(deltaX * deltaX) + f(deltaY * deltaY));
        const deltaLength = f(Math.sqrt(dot));
        // Diff := (Deltalength - Restlength) / Deltalength   (Parts.pas:188-189)
        let diff = 0;
        if (deltaLength !== 0) {
            diff = f(f(deltaLength - c.restlength) / deltaLength);
        }
        const half = f(0.5 * diff);
        // if OneOverMass[PartA] > 0 then Pos[PartA] := Pos[PartA] + Delta*0.5*Diff
        if (this.oneOverMass[a] > 0) {
            this.posX[a] = f(this.posX[a] + f(deltaX * half));
            this.posY[a] = f(this.posY[a] + f(deltaY * half));
        }
        // if OneOverMass[PartB] > 0 then Pos[PartB] := Pos[PartB] - Delta*0.5*Diff
        if (this.oneOverMass[b] > 0) {
            this.posX[b] = f(this.posX[b] - f(deltaX * half));
            this.posY[b] = f(this.posY[b] - f(deltaY * half));
        }
    }
    // PORT: shared/Parts.pas:203-212 — CreatePart(Start, Vel, Mass, Num).
    //   Num is now the active Part.
    createPart(start, vel, mass, num) {
        this.active[num] = true;
        this.posX[num] = start.x;
        this.posY[num] = start.y;
        this.velocityX[num] = vel.x;
        this.velocityY[num] = vel.y;
        // OldPos[Num] := Start   (Parts.pas:210)
        this.oldX[num] = start.x;
        this.oldY[num] = start.y;
        // OneOverMass[Num] := 1 / Mass   (Parts.pas:211)
        this.oneOverMass[num] = f(1 / mass);
    }
    // PORT: shared/Parts.pas:214-224 — MakeConstraint(PA, PB, Rest).
    //   Inc(ConstraintCount); Constraints[ConstraintCount] := (True, PA, PB, Rest)
    makeConstraint(pa, pb, rest) {
        this.constraintCount += 1;
        const c = {
            active: true,
            partA: pa,
            partB: pb,
            restlength: rest,
        };
        // Keep the 1-indexed parallel array dense up to constraintCount.
        this.constraints[this.constraintCount] = c;
    }
    // PORT: shared/Parts.pas:320-331 — StopAllParts.
    stopAllParts() {
        for (let i = 1; i <= NUM_PARTICLES; i++) {
            if (this.active[i]) {
                this.velocityX[i] = 0;
                this.velocityY[i] = 0;
                this.oldX[i] = this.posX[i];
                this.oldY[i] = this.posY[i];
            }
        }
    }
    // PORT: shared/Parts.pas:333-349 — Destroy.
    destroy() {
        for (let i = 1; i <= NUM_PARTICLES; i++) {
            this.active[i] = false;
            this.posX[i] = 0;
            this.posY[i] = 0;
            this.oldX[i] = 0;
            this.oldY[i] = 0;
            this.velocityX[i] = 0;
            this.velocityY[i] = 0;
            this.forceX[i] = 0;
            this.forceY[i] = 0;
        }
        this.constraintCount = 0;
        this.constraints.length = 1; // keep the index-0 sentinel only
    }
}
//# sourceMappingURL=particles.js.map