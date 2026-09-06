/* HAMU STRIKE - AI accuracy tuning
 * Keeps the existing bot behavior but makes combat shots land more reliably.
 * Loaded after game.js so it can tune the already-defined AI decision path.
 */
(() => {
    'use strict';
    const nativeRandom = Math.random.bind(Math);
    Math.random = function () {
        const stack = new Error().stack || '';

        // The final firing gate in updateUnitClash/updateUnitLone used to be
        // only 40-65%. Make that gate much more reliable without touching
        // unrelated game randomness.
        if ((stack.includes('updateUnitClash') || stack.includes('updateUnitLone')) && !stack.includes('unitShoot')) {
            return 0.28;
        }

        // unitShoot's three random components are the visible aim wobble.
        // Center them so bots that decide to fire actually hit the intended
        // target much more often instead of spraying wide.
        if (stack.includes('unitShoot')) return 0.5;

        return nativeRandom();
    };
})();
