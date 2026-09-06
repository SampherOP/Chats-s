/* HAMU STRIKE - CSMAP collision reinforcement v3
 * Makes the GLB's actual structural geometry physical: house walls, upper
 * planks/bridges, roofs, brown barrier boxes and other cover pieces.
 */
(() => {
    'use strict';
    const T = window.THREE;
    if (!T || !T.Box3 || !T.Box3.prototype.setFromObject) return;

    const originalSetFromObject = T.Box3.prototype.setFromObject;
    T.Box3.prototype.setFromObject = function (object, precise) {
        originalSetFromObject.call(this, object, precise);
        if (this.isEmpty()) return this;

        let sx = this.max.x - this.min.x;
        let sy = this.max.y - this.min.y;
        let sz = this.max.z - this.min.z;

        const MIN_XZ = 0.18;
        const MIN_Y = 0.18;
        const STRUCTURAL_LENGTH = 0.45;

        // Thin house walls / barrier faces: give them enough physical thickness
        // for the player's collision radius to stop at them.
        if (Math.max(sx, sz) >= STRUCTURAL_LENGTH) {
            if (sx < MIN_XZ) {
                const c = (this.min.x + this.max.x) * 0.5;
                this.min.x = c - MIN_XZ * 0.5;
                this.max.x = c + MIN_XZ * 0.5;
                sx = MIN_XZ;
            }
            if (sz < MIN_XZ) {
                const c = (this.min.z + this.max.z) * 0.5;
                this.min.z = c - MIN_XZ * 0.5;
                this.max.z = c + MIN_XZ * 0.5;
                sz = MIN_XZ;
            }
        }

        // Upper planks / bridges / roof slabs can be extremely thin in the GLB.
        // The game collider filter requires >= .18 height, so inflate thin solid
        // horizontal surfaces around their original center instead of dropping
        // them from the collision list.
        if (sy < MIN_Y && sx >= STRUCTURAL_LENGTH && sz >= STRUCTURAL_LENGTH) {
            const c = (this.min.y + this.max.y) * 0.5;
            this.min.y = c - MIN_Y * 0.5;
            this.max.y = c + MIN_Y * 0.5;
            sy = MIN_Y;
        }

        // Low brown crates/barriers: make substantial low geometry reach the
        // step/collision zone while preserving its approximate center height.
        if (this.max.y < 0.60 && sx >= 0.35 && sz >= 0.35 && sy >= 0.04) {
            this.max.y = Math.max(this.max.y, 0.60);
        }

        return this;
    };
})();
