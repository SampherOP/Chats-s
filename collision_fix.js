/* HAMU STRIKE - CSMAP collision reinforcement
 * Loaded before game.js. The map collider builder derives Box3s from every GLB
 * mesh, but thin walls/planks and low brown barrier/box geometry can otherwise
 * be rejected by its height/side filters. Inflate only genuinely solid-looking
 * structural meshes so they become physical without changing the visible GLB.
 */
(() => {
    'use strict';
    const T = window.THREE;
    if (!T || !T.Box3 || !T.Box3.prototype.setFromObject) return;

    const originalSetFromObject = T.Box3.prototype.setFromObject;
    T.Box3.prototype.setFromObject = function (object, precise) {
        const result = originalSetFromObject.call(this, object, precise);
        if (this.isEmpty()) return this;

        let sx = this.max.x - this.min.x;
        let sy = this.max.y - this.min.y;
        let sz = this.max.z - this.min.z;

        const MIN_SOLID_THICKNESS = 0.18;
        const STRUCTURAL_LENGTH = 0.55;

        // Thin structural pieces: walls, planks and barrier faces must have a
        // usable collision thickness even when the GLB mesh is paper-thin.
        if (Math.min(sx, sz) < MIN_SOLID_THICKNESS && Math.max(sx, sz) >= STRUCTURAL_LENGTH) {
            if (sx < MIN_SOLID_THICKNESS) {
                const c = (this.min.x + this.max.x) * 0.5;
                const h = MIN_SOLID_THICKNESS * 0.5;
                this.min.x = c - h;
                this.max.x = c + h;
                sx = MIN_SOLID_THICKNESS;
            }
            if (sz < MIN_SOLID_THICKNESS) {
                const c = (this.min.z + this.max.z) * 0.5;
                const h = MIN_SOLID_THICKNESS * 0.5;
                this.min.z = c - h;
                this.max.z = c + h;
                sz = MIN_SOLID_THICKNESS;
            }
        }

        // Brown barrier boxes and low cover pieces are often authored with their
        // top below the collider builder's old CS_STEP cutoff. Give substantial
        // ground-level boxes a real collision height instead of letting the
        // player walk straight through them.
        if (this.max.y < 0.60 && sx >= 0.35 && sz >= 0.35 && sy >= 0.04) {
            this.max.y = Math.max(this.max.y, 0.60);
            sy = this.max.y - this.min.y;
        }

        // Thin horizontal planks/bridges sometimes have sub-decimeter mesh
        // thickness. Give them a small collision thickness while preserving
        // their actual center height, so the player can stand on them reliably.
        if (sy < 0.10 && sx >= STRUCTURAL_LENGTH && sz >= STRUCTURAL_LENGTH) {
            const c = (this.min.y + this.max.y) * 0.5;
            const h = 0.05;
            this.min.y = c - h;
            this.max.y = c + h;
        }

        return this;
    };
})();
