export interface Vec2 {
    x: number;
    y: number;
}
export declare const vec2: (x?: number, y?: number) => Vec2;
export declare const clone: (a: Vec2) => Vec2;
export declare const add: (a: Vec2, b: Vec2) => Vec2;
export declare const sub: (a: Vec2, b: Vec2) => Vec2;
export declare const scale: (a: Vec2, s: number) => Vec2;
export declare const dot: (a: Vec2, b: Vec2) => number;
export declare const lengthSq: (a: Vec2) => number;
export declare const length: (a: Vec2) => number;
/** Returns a unit vector; the zero vector maps to (0, 0). */
export declare const normalize: (a: Vec2) => Vec2;
//# sourceMappingURL=vec2.d.ts.map