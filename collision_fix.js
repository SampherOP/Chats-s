/* HAMU STRIKE - CSMAP collision reinforcement
 * Loaded before game.js. The current map collider builder derives Box3s from
 * every GLB mesh, but very thin walls/planks can be rejected by its min-side
 * threshold. Inflate only genuinely thin structural meshes so they become
 * solid without changing the visible GLB.
 */
(() => {
    'use strict';
    const T = window.THREE;
    if (!T || !T.Box3 || !T.Box3.prototype.setFromObject) return;

    const originalSetFromObject = T.Box3.prototype.setFromObject;
    T.Box3.prototype.setFromObject = function (object, precise) {
        const result = originalSetFromObject.call(this, object, precise);
        if (this.isEmpty()) return this;

        const sx = this.max.x - this.min.x;
        const sy = this.max.y - this.min.y;
        const sz = this.max.z - this.min.z;

        // Only reinforce mesh-like structural pieces that are long in at least
        // one horizontal direction. Tiny decorative geometry is left alone.
        const MIN_SOLID_THICKNESS = 0.18;
        const STRUCTURAL_LENGTH = 0.55;

        if (Math.min(sx, sz) < MIN_SOLID_THICKNESS && Math.max(sx, sz) >= STRUCTURAL_LENGTH) {
            if (sx < MIN_SOLID_THICKNESS) {
                const c = (this.min.x + this.max.x) * 0.5;
                const h = MIN_SOLID_THICKNESS * 0.5;
                this.min.x = c - h;
                this.max.x = c + h;
            }
            if (sz < MIN_SOLID_THICKNESS) {
                const c = (this.min.z + this.max.z) * 0.5;
                const h = MIN_SOLID_THICKNESS * 0.5;
                this.min.z = c - h;
                this.max.z = c + h;
            }
        }

        // Thin horizontal planks/bridges sometimes have sub-decimeter mesh
        // thickness. Give them a small collision thickness while preserving
        // their actual top surface, so the player can stand on them reliably.
        if (sy < 0.10 && sx >= STRUCTURAL_LENGTH && sz >= STRUCTURAL_LENGTH) {
            const c = (this.min.y + this.max.y) * 0.5;
            const h = 0.05;
            this.min.y = c - h;
            this.max.y = c + h;
        }

        return this;
    };
})();
