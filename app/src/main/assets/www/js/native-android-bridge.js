/**
 * CutList Optimizer v1.126 — Native Android Bridge & Industrial 2D Guillotine Optimizer
 * Emulates the exact `window.android` JavascriptInterface from com.cutlistoptimizer
 * and runs 100% locally in the browser / WebView with zero external server dependency.
 *
 * Implements the full CutList Optimizer calculation engine:
 *  - Multi-stage Horizontal Strip & Vertical Strip Guillotine Packing (2-stage pure & 3-stage hybrid)
 *  - Multi-heuristic Recursive Guillotine Tree Packing (BSSF, BLSF, BAF, Collinear Strip Lookahead)
 *  - Full support for all options & settings:
 *      * Cut / blade / kerf thickness (cutThickness)
 *      * Grain direction / orientation locking (considerOrientation: 0=free, 1=along width, 2=along length)
 *      * Materials matching (isMaterialEnabled)
 *      * Edge banding per side & automatic length totals per sheet and globally (hasEdgeBanding)
 *      * Fit on one sheet / single stock sheet selection (useSingleStockUnit)
 *      * Optimization priority (0=Least wasted area, 1=Least number of cuts, 2=Smaller stock sheets used)
 *      * Cut orientation preference (0=Optimal, 1=Prefer cuts along width, 2=Prefer cuts along length)
 *      * Minimum trim dimension (minTrimDimension)
 *      * Stock sheet edge trim / squaring cuts (edgeTrim)
 */
(function () {
    // Non-blocking toast helper for sandboxed environments
    function showInPageNotice(msg, isError) {
        try {
            var container = document.querySelector('.toast-top-right');
            if (!container) {
                container = document.createElement('div');
                container.id = 'toast-container';
                container.className = 'toast-top-right';
                container.style.cssText = 'position:fixed;top:58px;right:12px;z-index:999999;';
                document.body.appendChild(container);
            }
            var toast = document.createElement('div');
            toast.className = 'toast ' + (isError ? 'toast-error' : 'toast-info');
            toast.style.cssText = 'margin-bottom:6px;padding:12px 16px;border-radius:4px;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,0.3);font-size:13px;min-width:240px;background-color:' + (isError ? '#c62828' : '#2e7d32') + ';';
            toast.textContent = msg;
            container.appendChild(toast);
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 3200);
        } catch (e) {
            console.log("Notice:", msg);
        }
    }

    // Override window.alert and window.confirm so they never fail inside sandboxed iframes
    var origConfirm = window.confirm;
    window.alert = function (msg) {
        showInPageNotice(String(msg || ''), false);
    };
    window.confirm = function (msg) {
        try {
            var r = origConfirm.call(window, msg);
            if (typeof r === 'boolean') return r;
        } catch (e) {}
        return true;
    };

    var tasksStore = {};
    var EPS = 1e-5;

    function roundClean(val) {
        return Math.round(val * 1000000) / 1000000;
    }

    function solveCutList(request) {
        var startTime = Date.now();
        var cfg = request.configuration || {};
        var kerf = Math.max(0, roundClean(parseFloat(cfg.cutThickness) || 0));
        var minTrim = Math.max(0, roundClean(parseFloat(cfg.minTrimDimension) || 0));
        var edgeTrim = Math.max(0, roundClean(parseFloat(cfg.edgeTrim) || 0));
        var considerMaterial = !!cfg.isMaterialEnabled;
        var considerGrain = !!cfg.considerOrientation;
        var hasEdgeBanding = !!cfg.hasEdgeBanding;
        var useSingleStock = !!cfg.useSingleStockUnit;
        var priority = parseInt(cfg.optimizationPriority, 10) || 0; // 0: Least wasted area, 1: Least cuts, 2: Smaller stock sheets
        var cutPref = parseInt(cfg.cutOrientationPreference, 10) || 0; // 0: Optimal, 1: Along width (y=), 2: Along length (x=)

        var reqPanels = [];
        var panelSummaryMap = {};
        var partUidCounter = 1;

        (request.panels || []).forEach(function (p) {
            if (p.enabled === false) return;
            var w = roundClean(parseFloat(p.width));
            var h = roundClean(parseFloat(p.height));
            var count = parseInt(p.count, 10) || 0;
            if (!(w > 0 && h > 0 && count > 0)) return;
            var mat = considerMaterial ? String(p.material || '').trim() : '';
            var ori = considerGrain ? (parseInt(p.orientation, 10) || 0) : 0;
            var edge = hasEdgeBanding && p.edge ? {
                top: p.edge.top || null,
                bottom: p.edge.bottom || null,
                left: p.edge.left || null,
                right: p.edge.right || null
            } : { top: null, bottom: null, left: null, right: null };

            panelSummaryMap[p.id] = {
                requestObjId: p.id,
                width: w,
                height: h,
                count: count,
                label: p.label || null,
                material: p.material || null,
                enabled: true
            };

            for (var i = 0; i < count; i++) {
                reqPanels.push({
                    uid: partUidCounter++,
                    requestObjId: p.id,
                    width: w,
                    height: h,
                    area: roundClean(w * h),
                    label: p.label || null,
                    material: mat,
                    rawMaterial: p.material || null,
                    orientation: ori,
                    edge: edge
                });
            }
        });

        var availStocks = [];
        (request.stockPanels || []).forEach(function (s) {
            if (s.enabled === false) return;
            var w = roundClean(parseFloat(s.width));
            var h = roundClean(parseFloat(s.height));
            var count = parseInt(s.count, 10) || 0;
            if (!(w > 0 && h > 0 && count > 0)) return;
            var mat = considerMaterial ? String(s.material || '').trim() : '';
            var ori = considerGrain ? (parseInt(s.orientation, 10) || 0) : 0;
            var maxCount = useSingleStock ? 1 : count;
            for (var i = 0; i < maxCount; i++) {
                availStocks.push({
                    requestObjId: s.id,
                    width: w,
                    height: h,
                    area: roundClean(w * h),
                    label: s.label || null,
                    material: mat,
                    rawMaterial: s.material || null,
                    orientation: ori
                });
            }
        });

        // Check whether a part fits inside (rectW, rectH) on a sheet with stockOri
        function canFit(part, rectW, rectH, stockOri) {
            var normalOk = (part.width <= rectW + EPS && part.height <= rectH + EPS);
            var rotOk = (part.height <= rectW + EPS && part.width <= rectH + EPS);

            if (considerGrain && part.orientation !== 0) {
                if (stockOri !== 0) {
                    if (part.orientation === stockOri) {
                        rotOk = false;
                    } else {
                        normalOk = false;
                    }
                } else {
                    // Stock has no grain specified, but part has grain locked: keep part in its normal orientation
                    rotOk = false;
                }
            }
            return { normalOk: normalOk, rotOk: rotOk };
        }

        // Helper to get valid orientations [{ rot, pw, ph }] of part inside (rectW, rectH)
        function getPartPlacements(part, rectW, rectH, stockOri, preferRotated) {
            var fit = canFit(part, rectW, rectH, stockOri);
            var list = [];
            if (preferRotated) {
                if (fit.rotOk) list.push({ rot: true, pw: part.height, ph: part.width });
                if (fit.normalOk && (part.width !== part.height || !fit.rotOk)) list.push({ rot: false, pw: part.width, ph: part.height });
            } else {
                if (fit.normalOk) list.push({ rot: false, pw: part.width, ph: part.height });
                if (fit.rotOk && (part.width !== part.height || !fit.normalOk)) list.push({ rot: true, pw: part.height, ph: part.width });
            }
            return list;
        }

        // Apply optional Edge Trim (squaring raw stock sheet edges before cutting parts)
        function applyEdgeTrimToRoot(rootTile, tiles, cuts, stockOri, nextTileIdRef) {
            var activeNode = rootTile;
            if (edgeTrim <= EPS) return activeNode;
            if (activeNode.width <= 2 * edgeTrim + EPS || activeNode.height <= 2 * edgeTrim + EPS) {
                return activeNode;
            }

            // Cut 1: Bottom trim at y = edgeTrim
            activeNode.hasChildren = true;
            var botTrim = {
                id: nextTileIdRef.val++, requestObjId: null,
                x: activeNode.x, y: activeNode.y, width: activeNode.width, height: edgeTrim,
                hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null, isTrim: true
            };
            var remAfterBotH = roundClean(Math.max(0, activeNode.height - edgeTrim - kerf));
            var afterBot = {
                id: nextTileIdRef.val++, requestObjId: null,
                x: activeNode.x, y: roundClean(activeNode.y + edgeTrim + kerf), width: activeNode.width, height: remAfterBotH,
                hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
            };
            tiles.push(botTrim, afterBot);
            cuts.push({
                originalTileId: activeNode.id, originalWidth: activeNode.width, originalHeight: activeNode.height,
                x1: activeNode.x, y1: roundClean(activeNode.y + edgeTrim), x2: roundClean(activeNode.x + activeNode.width), y2: roundClean(activeNode.y + edgeTrim),
                cutCoord: edgeTrim, horizontal: false, isHorizontal: false,
                child1TileId: botTrim.id, child2TileId: afterBot.id
            });
            activeNode = afterBot;

            // Cut 2: Top trim leaving height = activeNode.height - edgeTrim - kerf
            var innerH = roundClean(Math.max(0, activeNode.height - edgeTrim - kerf));
            if (innerH > EPS) {
                activeNode.hasChildren = true;
                var innerYNode = {
                    id: nextTileIdRef.val++, requestObjId: null,
                    x: activeNode.x, y: activeNode.y, width: activeNode.width, height: innerH,
                    hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
                };
                var topTrim = {
                    id: nextTileIdRef.val++, requestObjId: null,
                    x: activeNode.x, y: roundClean(activeNode.y + innerH + kerf), width: activeNode.width, height: edgeTrim,
                    hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null, isTrim: true
                };
                tiles.push(innerYNode, topTrim);
                cuts.push({
                    originalTileId: activeNode.id, originalWidth: activeNode.width, originalHeight: activeNode.height,
                    x1: activeNode.x, y1: roundClean(activeNode.y + innerH), x2: roundClean(activeNode.x + activeNode.width), y2: roundClean(activeNode.y + innerH),
                    cutCoord: innerH, horizontal: false, isHorizontal: false,
                    child1TileId: innerYNode.id, child2TileId: topTrim.id
                });
                activeNode = innerYNode;
            }

            // Cut 3: Left trim at x = edgeTrim
            activeNode.hasChildren = true;
            var leftTrim = {
                id: nextTileIdRef.val++, requestObjId: null,
                x: activeNode.x, y: activeNode.y, width: edgeTrim, height: activeNode.height,
                hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null, isTrim: true
            };
            var remAfterLeftW = roundClean(Math.max(0, activeNode.width - edgeTrim - kerf));
            var afterLeft = {
                id: nextTileIdRef.val++, requestObjId: null,
                x: roundClean(activeNode.x + edgeTrim + kerf), y: activeNode.y, width: remAfterLeftW, height: activeNode.height,
                hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
            };
            tiles.push(leftTrim, afterLeft);
            cuts.push({
                originalTileId: activeNode.id, originalWidth: activeNode.width, originalHeight: activeNode.height,
                x1: roundClean(activeNode.x + edgeTrim), y1: activeNode.y, x2: roundClean(activeNode.x + edgeTrim), y2: roundClean(activeNode.y + activeNode.height),
                cutCoord: edgeTrim, horizontal: true, isHorizontal: true,
                child1TileId: leftTrim.id, child2TileId: afterLeft.id
            });
            activeNode = afterLeft;

            // Cut 4: Right trim leaving width = activeNode.width - edgeTrim - kerf
            var innerW = roundClean(Math.max(0, activeNode.width - edgeTrim - kerf));
            if (innerW > EPS) {
                activeNode.hasChildren = true;
                var innerCore = {
                    id: nextTileIdRef.val++, requestObjId: null,
                    x: activeNode.x, y: activeNode.y, width: innerW, height: activeNode.height,
                    hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
                };
                var rightTrim = {
                    id: nextTileIdRef.val++, requestObjId: null,
                    x: roundClean(activeNode.x + innerW + kerf), y: activeNode.y, width: edgeTrim, height: activeNode.height,
                    hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null, isTrim: true
                };
                tiles.push(innerCore, rightTrim);
                cuts.push({
                    originalTileId: activeNode.id, originalWidth: activeNode.width, originalHeight: activeNode.height,
                    x1: roundClean(activeNode.x + innerW), y1: activeNode.y, x2: roundClean(activeNode.x + innerW), y2: roundClean(activeNode.y + activeNode.height),
                    cutCoord: innerW, horizontal: true, isHorizontal: true,
                    child1TileId: innerCore.id, child2TileId: rightTrim.id
                });
                activeNode = innerCore;
            }

            return activeNode;
        }

        // Perform a single guillotine placement of `chosen` (with dimensions pw x ph and rotation `rot`) at bottom-left of `node`
        function placePartInNode(node, chosen, pw, ph, rot, splitAlongXFirst, stockOri, tiles, cuts, nextTileIdRef) {
            pw = roundClean(pw);
            ph = roundClean(ph);
            var dw = roundClean(node.width - pw);
            var dh = roundClean(node.height - ph);

            // Exact fit in both dimensions: no cut needed!
            if (dw <= EPS && dh <= EPS) {
                node.final = true;
                node.isFinal = true;
                node.requestObjId = chosen.requestObjId;
                node.label = chosen.label;
                node.rotated = rot;
                node.isRotated = rot;
                node.edge = chosen.edge;
                return [];
            }

            // If dw <= EPS, only a horizontal cut at y = ph is needed
            if (dw <= EPS) {
                splitAlongXFirst = false;
            } else if (dh <= EPS) {
                // If dh <= EPS, only a vertical cut at x = pw is needed
                splitAlongXFirst = true;
            }

            if (splitAlongXFirst) {
                // Vertical cut at x = pw first
                node.hasChildren = true;
                var rightW = roundClean(Math.max(0, node.width - pw - kerf));
                var child1 = {
                    id: nextTileIdRef.val++, requestObjId: null,
                    x: node.x, y: node.y, width: pw, height: node.height,
                    hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
                };
                var child2 = rightW > EPS ? {
                    id: nextTileIdRef.val++, requestObjId: null,
                    x: roundClean(node.x + pw + kerf), y: node.y, width: rightW, height: node.height,
                    hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
                } : null;
                tiles.push(child1);
                if (child2) tiles.push(child2);

                cuts.push({
                    originalTileId: node.id, originalWidth: node.width, originalHeight: node.height,
                    x1: roundClean(node.x + pw), y1: node.y, x2: roundClean(node.x + pw), y2: roundClean(node.y + node.height),
                    cutCoord: pw, horizontal: true, isHorizontal: true,
                    child1TileId: child1.id, child2TileId: child2 ? child2.id : -1
                });

                if (dh > EPS) {
                    // Horizontal cut inside child1 at y = ph
                    child1.hasChildren = true;
                    var topH = roundClean(Math.max(0, child1.height - ph - kerf));
                    var gc1 = {
                        id: nextTileIdRef.val++, requestObjId: chosen.requestObjId,
                        x: child1.x, y: child1.y, width: pw, height: ph,
                        hasChildren: false, final: true, isFinal: true, rotated: rot, isRotated: rot,
                        label: chosen.label, orientation: chosen.orientation, edge: chosen.edge
                    };
                    var gc2 = topH > EPS ? {
                        id: nextTileIdRef.val++, requestObjId: null,
                        x: child1.x, y: roundClean(child1.y + ph + kerf), width: pw, height: topH,
                        hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
                    } : null;
                    tiles.push(gc1);
                    if (gc2) tiles.push(gc2);

                    cuts.push({
                        originalTileId: child1.id, originalWidth: child1.width, originalHeight: child1.height,
                        x1: child1.x, y1: roundClean(child1.y + ph), x2: roundClean(child1.x + child1.width), y2: roundClean(child1.y + ph),
                        cutCoord: ph, horizontal: false, isHorizontal: false,
                        child1TileId: gc1.id, child2TileId: gc2 ? gc2.id : -1
                    });

                    var nextNodes = [];
                    if (gc2 && gc2.width >= minTrim - EPS && gc2.height >= minTrim - EPS) nextNodes.push(gc2);
                    if (child2 && child2.width >= minTrim - EPS && child2.height >= minTrim - EPS) nextNodes.push(child2);
                    return nextNodes;
                } else {
                    child1.final = true;
                    child1.isFinal = true;
                    child1.requestObjId = chosen.requestObjId;
                    child1.label = chosen.label;
                    child1.rotated = rot;
                    child1.isRotated = rot;
                    child1.edge = chosen.edge;
                    if (child2 && child2.width >= minTrim - EPS && child2.height >= minTrim - EPS) return [child2];
                    return [];
                }
            } else {
                // Horizontal cut at y = ph first
                node.hasChildren = true;
                var topH2 = roundClean(Math.max(0, node.height - ph - kerf));
                var ch1 = {
                    id: nextTileIdRef.val++, requestObjId: null,
                    x: node.x, y: node.y, width: node.width, height: ph,
                    hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
                };
                var ch2 = topH2 > EPS ? {
                    id: nextTileIdRef.val++, requestObjId: null,
                    x: node.x, y: roundClean(node.y + ph + kerf), width: node.width, height: topH2,
                    hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
                } : null;
                tiles.push(ch1);
                if (ch2) tiles.push(ch2);

                cuts.push({
                    originalTileId: node.id, originalWidth: node.width, originalHeight: node.height,
                    x1: node.x, y1: roundClean(node.y + ph), x2: roundClean(node.x + node.width), y2: roundClean(node.y + ph),
                    cutCoord: ph, horizontal: false, isHorizontal: false,
                    child1TileId: ch1.id, child2TileId: ch2 ? ch2.id : -1
                });

                if (dw > EPS) {
                    // Vertical cut inside ch1 at x = pw
                    ch1.hasChildren = true;
                    var rightW2 = roundClean(Math.max(0, ch1.width - pw - kerf));
                    var gch1 = {
                        id: nextTileIdRef.val++, requestObjId: chosen.requestObjId,
                        x: ch1.x, y: ch1.y, width: pw, height: ph,
                        hasChildren: false, final: true, isFinal: true, rotated: rot, isRotated: rot,
                        label: chosen.label, orientation: chosen.orientation, edge: chosen.edge
                    };
                    var gch2 = rightW2 > EPS ? {
                        id: nextTileIdRef.val++, requestObjId: null,
                        x: roundClean(ch1.x + pw + kerf), y: ch1.y, width: rightW2, height: ph,
                        hasChildren: false, final: false, rotated: false, label: null, orientation: stockOri, edge: null
                    } : null;
                    tiles.push(gch1);
                    if (gch2) tiles.push(gch2);

                    cuts.push({
                        originalTileId: ch1.id, originalWidth: ch1.width, originalHeight: ch1.height,
                        x1: roundClean(ch1.x + pw), y1: ch1.y, x2: roundClean(ch1.x + pw), y2: roundClean(ch1.y + ch1.height),
                        cutCoord: pw, horizontal: true, isHorizontal: true,
                        child1TileId: gch1.id, child2TileId: gch2 ? gch2.id : -1
                    });

                    var nextNodes2 = [];
                    if (gch2 && gch2.width >= minTrim - EPS && gch2.height >= minTrim - EPS) nextNodes2.push(gch2);
                    if (ch2 && ch2.width >= minTrim - EPS && ch2.height >= minTrim - EPS) nextNodes2.push(ch2);
                    return nextNodes2;
                } else {
                    ch1.final = true;
                    ch1.isFinal = true;
                    ch1.requestObjId = chosen.requestObjId;
                    ch1.label = chosen.label;
                    ch1.rotated = rot;
                    ch1.isRotated = rot;
                    ch1.edge = chosen.edge;
                    if (ch2 && ch2.width >= minTrim - EPS && ch2.height >= minTrim - EPS) return [ch2];
                    return [];
                }
            }
        }

        // Summarize a completed packing attempt
        function finalizeAttempt(tiles, cuts, remainingPool) {
            var usedArea = 0;
            var nbrFinal = 0;
            var maxOffcutArea = 0;
            tiles.forEach(function (t) {
                if (!t.hasChildren) {
                    var a = roundClean(t.width * t.height);
                    if (t.final) {
                        usedArea = roundClean(usedArea + a);
                        nbrFinal++;
                    } else if (!t.isTrim) {
                        if (a > maxOffcutArea) maxOffcutArea = a;
                    }
                }
            });
            var cutLen = 0;
            cuts.forEach(function (c) {
                cutLen = roundClean(cutLen + Math.hypot(c.x2 - c.x1, c.y2 - c.y1));
            });
            return {
                tiles: tiles,
                cuts: cuts,
                usedArea: usedArea,
                nbrFinal: nbrFinal,
                cutLength: cutLen,
                maxOffcutArea: maxOffcutArea,
                remaining: remainingPool
            };
        }

        // =========================================================================
        // SOLVER FAMILY 1: Stage-Based Strip / Shelf Guillotine Optimizer
        // Supports both Pure 2-Stage Strips (fillRemainder=false) and 3-Stage Hybrid (fillRemainder=true)
        // =========================================================================
        function packByStrips(stock, pool, horizontalStripsFirst, stripMode, preferRot, fillRemainder) {
            var localPool = [];
            var ignoredPool = [];
            for (var i = 0; i < pool.length; i++) {
                if (considerMaterial && pool[i].material !== stock.material) {
                    ignoredPool.push(pool[i]);
                } else {
                    localPool.push(pool[i]);
                }
            }

            var nextTileIdRef = { val: 1 };
            var tiles = [];
            var cuts = [];

            var rootTile = {
                id: nextTileIdRef.val++,
                requestObjId: stock.requestObjId,
                x: 0,
                y: 0,
                width: stock.width,
                height: stock.height,
                hasChildren: false,
                final: false,
                rotated: false,
                label: stock.label,
                orientation: stock.orientation,
                edge: null
            };
            tiles.push(rootTile);

            var startNode = applyEdgeTrimToRoot(rootTile, tiles, cuts, stock.orientation, nextTileIdRef);

            // Recursive helper for sub-rectangles inside a strip
            function packSubRect(subNode, allowStripAxisFirst) {
                if (!subNode || subNode.width < minTrim - EPS || subNode.height < minTrim - EPS || localPool.length === 0) return;

                var bestIdx = -1;
                var bestPlacement = null;
                var bestScore = -Infinity;

                for (var idx = 0; idx < localPool.length; idx++) {
                    var p = localPool[idx];
                    var placements = getPartPlacements(p, subNode.width, subNode.height, stock.orientation, preferRot);
                    for (var c = 0; c < placements.length; c++) {
                        var pl = placements[c];
                        var exactW = Math.abs(subNode.width - pl.pw) <= EPS;
                        var exactH = Math.abs(subNode.height - pl.ph) <= EPS;
                        var score = pl.pw * pl.ph;
                        if (exactW && exactH) score += 1e12;
                        else if (horizontalStripsFirst && exactH) score += 1e9 + pl.pw * 1000;
                        else if (!horizontalStripsFirst && exactW) score += 1e9 + pl.ph * 1000;
                        else if (exactW || exactH) score += 1e8;

                        var copiesX = Math.floor((subNode.width + kerf + EPS) / (pl.pw + kerf));
                        var copiesY = Math.floor((subNode.height + kerf + EPS) / (pl.ph + kerf));
                        score += Math.max(copiesX * pl.pw / subNode.width, copiesY * pl.ph / subNode.height) * 1e5;

                        if (score > bestScore) {
                            bestScore = score;
                            bestIdx = idx;
                            bestPlacement = pl;
                        }
                    }
                }

                if (bestIdx === -1) return;

                var chosen = localPool.splice(bestIdx, 1)[0];
                var splitX = horizontalStripsFirst ? true : false;
                if (cutPref === 1) splitX = false;
                else if (cutPref === 2) splitX = true;
                else if (Math.abs(subNode.height - bestPlacement.ph) <= EPS) splitX = true;
                else if (Math.abs(subNode.width - bestPlacement.pw) <= EPS) splitX = false;

                var children = placePartInNode(subNode, chosen, bestPlacement.pw, bestPlacement.ph, bestPlacement.rot, splitX, stock.orientation, tiles, cuts, nextTileIdRef);
                for (var k = 0; k < children.length; k++) {
                    packSubRect(children[k], allowStripAxisFirst);
                }
            }

            if (horizontalStripsFirst) {
                var curNode = startNode;
                while (curNode && localPool.length > 0 && curNode.width >= minTrim - EPS && curNode.height >= minTrim - EPS) {
                    var candHeightsMap = {};
                    for (var i = 0; i < localPool.length; i++) {
                        var p = localPool[i];
                        var pls = getPartPlacements(p, curNode.width, curNode.height, stock.orientation, preferRot);
                        for (var j = 0; j < pls.length; j++) {
                            var hKey = roundClean(pls[j].ph);
                            candHeightsMap[hKey] = hKey;
                        }
                    }
                    var candHeights = Object.values(candHeightsMap);
                    if (candHeights.length === 0) break;

                    var bestStrip = null;
                    for (var chIdx = 0; chIdx < candHeights.length; chIdx++) {
                        var Hs = candHeights[chIdx];
                        var exactMatches = [];
                        for (var m = 0; m < localPool.length; m++) {
                            var pm = localPool[m];
                            var plsM = getPartPlacements(pm, curNode.width, curNode.height, stock.orientation, preferRot);
                            for (var jm = 0; jm < plsM.length; jm++) {
                                if (Math.abs(plsM[jm].ph - Hs) <= EPS) {
                                    exactMatches.push({ poolIdx: m, part: pm, pw: plsM[jm].pw, ph: plsM[jm].ph, rot: plsM[jm].rot });
                                    break;
                                }
                            }
                        }

                        exactMatches.sort(function (a, b) {
                            if (Math.abs(b.pw - a.pw) > EPS) return b.pw - a.pw;
                            return a.poolIdx - b.poolIdx;
                        });

                        var chosenItems = [];
                        var usedPoolIndices = {};
                        var remW = curNode.width;
                        var exactUsedArea = 0;
                        for (var em = 0; em < exactMatches.length; em++) {
                            var item = exactMatches[em];
                            if (item.pw <= remW + EPS) {
                                chosenItems.push(item);
                                usedPoolIndices[item.poolIdx] = true;
                                exactUsedArea = roundClean(exactUsedArea + item.pw * item.ph);
                                remW = roundClean(Math.max(0, remW - item.pw - kerf));
                            }
                        }

                        var extraArea = 0;
                        var simRemW = remW;
                        if (fillRemainder && simRemW > EPS) {
                            for (var sm = 0; sm < localPool.length; sm++) {
                                if (usedPoolIndices[sm]) continue;
                                var pSm = localPool[sm];
                                var plsSm = getPartPlacements(pSm, simRemW, Hs, stock.orientation, preferRot);
                                if (plsSm.length > 0) {
                                    var pl0 = plsSm[0];
                                    var vStack = Math.min(1, Math.floor((Hs + kerf + EPS) / (pl0.ph + kerf)));
                                    extraArea += pl0.pw * pl0.ph * vStack;
                                    simRemW = roundClean(Math.max(0, simRemW - pl0.pw - kerf));
                                }
                            }
                        }

                        var totalStripArea = exactUsedArea + extraArea;
                        var stripCap = curNode.width * Hs;
                        var fillRatio = stripCap > 0 ? (totalStripArea / stripCap) : 0;
                        var exactFillRatio = stripCap > 0 ? (exactUsedArea / stripCap) : 0;
                        var leftoverH = roundClean(curNode.height - Hs);
                        var trimPenalty = (leftoverH > EPS && leftoverH - kerf < minTrim - EPS) ? -1e8 : 0;

                        var stripScore = 0;
                        if (stripMode === 0) {
                            stripScore = Hs * 1e6 + exactFillRatio * 1e5 + fillRatio * 1e4 + chosenItems.length * 100 + trimPenalty;
                        } else if (stripMode === 1) {
                            stripScore = fillRatio * 1e8 + exactFillRatio * 1e6 + Hs * 1000 + trimPenalty;
                        } else if (stripMode === 2) {
                            stripScore = chosenItems.length * 1e7 + exactFillRatio * 1e6 + Hs * 1000 + trimPenalty;
                        } else {
                            stripScore = totalStripArea * 1e4 + exactFillRatio * 1e6 + trimPenalty;
                        }

                        if (!bestStrip || stripScore > bestStrip.score) {
                            bestStrip = {
                                Hs: Hs,
                                items: chosenItems,
                                score: stripScore
                            };
                        }
                    }

                    if (!bestStrip || bestStrip.items.length === 0) {
                        packSubRect(curNode, true);
                        break;
                    }

                    var chosenUids = {};
                    bestStrip.items.forEach(function (it) { chosenUids[it.part.uid] = true; });
                    localPool = localPool.filter(function (p) { return !chosenUids[p.uid]; });

                    var Hs = bestStrip.Hs;
                    var dh = roundClean(curNode.height - Hs);
                    var stripNode = curNode;
                    var nextBoardNode = null;

                    if (dh > EPS) {
                        curNode.hasChildren = true;
                        var topRemH = roundClean(Math.max(0, curNode.height - Hs - kerf));
                        stripNode = {
                            id: nextTileIdRef.val++, requestObjId: null,
                            x: curNode.x, y: curNode.y, width: curNode.width, height: Hs,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        };
                        nextBoardNode = topRemH > EPS ? {
                            id: nextTileIdRef.val++, requestObjId: null,
                            x: curNode.x, y: roundClean(curNode.y + Hs + kerf), width: curNode.width, height: topRemH,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        } : null;
                        tiles.push(stripNode);
                        if (nextBoardNode) tiles.push(nextBoardNode);

                        cuts.push({
                            originalTileId: curNode.id, originalWidth: curNode.width, originalHeight: curNode.height,
                            x1: curNode.x, y1: roundClean(curNode.y + Hs), x2: roundClean(curNode.x + curNode.width), y2: roundClean(curNode.y + Hs),
                            cutCoord: Hs, horizontal: false, isHorizontal: false,
                            child1TileId: stripNode.id, child2TileId: nextBoardNode ? nextBoardNode.id : -1
                        });
                    }

                    var curStripRem = stripNode;
                    for (var sIdx = 0; sIdx < bestStrip.items.length; sIdx++) {
                        if (!curStripRem) break;
                        var it = bestStrip.items[sIdx];
                        var nextRemList = placePartInNode(curStripRem, it.part, it.pw, it.ph, it.rot, true, stock.orientation, tiles, cuts, nextTileIdRef);
                        curStripRem = nextRemList.length > 0 ? nextRemList[0] : null;
                    }

                    if (fillRemainder && curStripRem && localPool.length > 0) {
                        packSubRect(curStripRem, true);
                    }

                    curNode = nextBoardNode;
                }
            } else {
                var curNodeV = startNode;
                while (curNodeV && localPool.length > 0 && curNodeV.width >= minTrim - EPS && curNodeV.height >= minTrim - EPS) {
                    var candWidthsMap = {};
                    for (var iv = 0; iv < localPool.length; iv++) {
                        var pv = localPool[iv];
                        var plsV = getPartPlacements(pv, curNodeV.width, curNodeV.height, stock.orientation, preferRot);
                        for (var jv = 0; jv < plsV.length; jv++) {
                            var wKey = roundClean(plsV[jv].pw);
                            candWidthsMap[wKey] = wKey;
                        }
                    }
                    var candWidths = Object.values(candWidthsMap);
                    if (candWidths.length === 0) break;

                    var bestVStrip = null;
                    for (var cwIdx = 0; cwIdx < candWidths.length; cwIdx++) {
                        var Ws = candWidths[cwIdx];
                        var exactVMatches = [];
                        for (var mv = 0; mv < localPool.length; mv++) {
                            var pmv = localPool[mv];
                            var plsMv = getPartPlacements(pmv, curNodeV.width, curNodeV.height, stock.orientation, preferRot);
                            for (var jmv = 0; jmv < plsMv.length; jmv++) {
                                if (Math.abs(plsMv[jmv].pw - Ws) <= EPS) {
                                    exactVMatches.push({ poolIdx: mv, part: pmv, pw: plsMv[jmv].pw, ph: plsMv[jmv].ph, rot: plsMv[jmv].rot });
                                    break;
                                }
                            }
                        }

                        exactVMatches.sort(function (a, b) {
                            if (Math.abs(b.ph - a.ph) > EPS) return b.ph - a.ph;
                            return a.poolIdx - b.poolIdx;
                        });

                        var chosenVItems = [];
                        var usedVIndices = {};
                        var remH = curNodeV.height;
                        var exactVArea = 0;
                        for (var emv = 0; emv < exactVMatches.length; emv++) {
                            var itemV = exactVMatches[emv];
                            if (itemV.ph <= remH + EPS) {
                                chosenVItems.push(itemV);
                                usedVIndices[itemV.poolIdx] = true;
                                exactVArea = roundClean(exactVArea + itemV.pw * itemV.ph);
                                remH = roundClean(Math.max(0, remH - itemV.ph - kerf));
                            }
                        }

                        var extraVArea = 0;
                        var simRemH = remH;
                        if (fillRemainder && simRemH > EPS) {
                            for (var smv = 0; smv < localPool.length; smv++) {
                                if (usedVIndices[smv]) continue;
                                var pSmv = localPool[smv];
                                var plsSmv = getPartPlacements(pSmv, Ws, simRemH, stock.orientation, preferRot);
                                if (plsSmv.length > 0) {
                                    var pl0v = plsSmv[0];
                                    extraVArea += pl0v.pw * pl0v.ph;
                                    simRemH = roundClean(Math.max(0, simRemH - pl0v.ph - kerf));
                                }
                            }
                        }

                        var totalVStripArea = exactVArea + extraVArea;
                        var vStripCap = Ws * curNodeV.height;
                        var vFillRatio = vStripCap > 0 ? (totalVStripArea / vStripCap) : 0;
                        var exactVFillRatio = vStripCap > 0 ? (exactVArea / vStripCap) : 0;
                        var leftoverW = roundClean(curNodeV.width - Ws);
                        var vTrimPenalty = (leftoverW > EPS && leftoverW - kerf < minTrim - EPS) ? -1e8 : 0;

                        var vStripScore = 0;
                        if (stripMode === 0) {
                            vStripScore = Ws * 1e6 + exactVFillRatio * 1e5 + vFillRatio * 1e4 + chosenVItems.length * 100 + vTrimPenalty;
                        } else if (stripMode === 1) {
                            vStripScore = vFillRatio * 1e8 + exactVFillRatio * 1e6 + Ws * 1000 + vTrimPenalty;
                        } else if (stripMode === 2) {
                            vStripScore = chosenVItems.length * 1e7 + exactVFillRatio * 1e6 + Ws * 1000 + vTrimPenalty;
                        } else {
                            vStripScore = totalVStripArea * 1e4 + exactVFillRatio * 1e6 + vTrimPenalty;
                        }

                        if (!bestVStrip || vStripScore > bestVStrip.score) {
                            bestVStrip = {
                                Ws: Ws,
                                items: chosenVItems,
                                score: vStripScore
                            };
                        }
                    }

                    if (!bestVStrip || bestVStrip.items.length === 0) {
                        packSubRect(curNodeV, false);
                        break;
                    }

                    var chosenVUids = {};
                    bestVStrip.items.forEach(function (it) { chosenVUids[it.part.uid] = true; });
                    localPool = localPool.filter(function (p) { return !chosenVUids[p.uid]; });

                    var Ws = bestVStrip.Ws;
                    var dw = roundClean(curNodeV.width - Ws);
                    var vStripNode = curNodeV;
                    var nextBoardNodeV = null;

                    if (dw > EPS) {
                        curNodeV.hasChildren = true;
                        var rightRemW = roundClean(Math.max(0, curNodeV.width - Ws - kerf));
                        vStripNode = {
                            id: nextTileIdRef.val++, requestObjId: null,
                            x: curNodeV.x, y: curNodeV.y, width: Ws, height: curNodeV.height,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        };
                        nextBoardNodeV = rightRemW > EPS ? {
                            id: nextTileIdRef.val++, requestObjId: null,
                            x: roundClean(curNodeV.x + Ws + kerf), y: curNodeV.y, width: rightRemW, height: curNodeV.height,
                            hasChildren: false, final: false, rotated: false, label: null, orientation: stock.orientation, edge: null
                        } : null;
                        tiles.push(vStripNode);
                        if (nextBoardNodeV) tiles.push(nextBoardNodeV);

                        cuts.push({
                            originalTileId: curNodeV.id, originalWidth: curNodeV.width, originalHeight: curNodeV.height,
                            x1: roundClean(curNodeV.x + Ws), y1: curNodeV.y, x2: roundClean(curNodeV.x + Ws), y2: roundClean(curNodeV.y + curNodeV.height),
                            cutCoord: Ws, horizontal: true, isHorizontal: true,
                            child1TileId: vStripNode.id, child2TileId: nextBoardNodeV ? nextBoardNodeV.id : -1
                        });
                    }

                    var curVStripRem = vStripNode;
                    for (var svIdx = 0; svIdx < bestVStrip.items.length; svIdx++) {
                        if (!curVStripRem) break;
                        var itv = bestVStrip.items[svIdx];
                        var nextVRemList = placePartInNode(curVStripRem, itv.part, itv.pw, itv.ph, itv.rot, false, stock.orientation, tiles, cuts, nextTileIdRef);
                        curVStripRem = nextVRemList.length > 0 ? nextVRemList[0] : null;
                    }

                    if (fillRemainder && curVStripRem && localPool.length > 0) {
                        packSubRect(curVStripRem, false);
                    }

                    curNodeV = nextBoardNodeV;
                }
            }

            return finalizeAttempt(tiles, cuts, localPool.concat(ignoredPool));
        }

        // =========================================================================
        // SOLVER FAMILY 2: Multi-Heuristic Recursive Guillotine Tree Optimizer
        // =========================================================================
        function packRecursiveGuillotine(stock, pool, sortMode, splitRule, scoreMode) {
            var localPool = [];
            var ignoredPool = [];
            for (var i = 0; i < pool.length; i++) {
                if (considerMaterial && pool[i].material !== stock.material) {
                    ignoredPool.push(pool[i]);
                } else {
                    localPool.push(pool[i]);
                }
            }

            if (sortMode === 1) {
                localPool.sort(function (a, b) { return (b.area - a.area) || (Math.max(b.width, b.height) - Math.max(a.width, a.height)); });
            } else if (sortMode === 2) {
                localPool.sort(function (a, b) { return (b.height - a.height) || (b.width - a.width); });
            } else if (sortMode === 3) {
                localPool.sort(function (a, b) { return (b.width - a.width) || (b.height - a.height); });
            } else if (sortMode === 4) {
                localPool.sort(function (a, b) {
                    var maxA = Math.max(a.width, a.height), maxB = Math.max(b.width, b.height);
                    if (Math.abs(maxB - maxA) > EPS) return maxB - maxA;
                    return Math.min(b.width, b.height) - Math.min(a.width, a.height);
                });
            } else if (sortMode === 5) {
                localPool.sort(function (a, b) { return ((b.width + b.height) - (a.width + a.height)) || (b.area - a.area); });
            }

            var nextTileIdRef = { val: 1 };
            var tiles = [];
            var cuts = [];

            var rootTile = {
                id: nextTileIdRef.val++,
                requestObjId: stock.requestObjId,
                x: 0,
                y: 0,
                width: stock.width,
                height: stock.height,
                hasChildren: false,
                final: false,
                rotated: false,
                label: stock.label,
                orientation: stock.orientation,
                edge: null
            };
            tiles.push(rootTile);

            var startNode = applyEdgeTrimToRoot(rootTile, tiles, cuts, stock.orientation, nextTileIdRef);

            function packNode(node) {
                if (!node || node.width < minTrim - EPS || node.height < minTrim - EPS || localPool.length === 0) return;

                var bestIdx = -1;
                var bestRotated = false;
                var bestScore = Infinity;

                for (var i = 0; i < localPool.length; i++) {
                    var p = localPool[i];
                    var fit = canFit(p, node.width, node.height, stock.orientation);
                    if (!fit.normalOk && !fit.rotOk) continue;

                    var candidates = [];
                    if (fit.normalOk) candidates.push({ rot: false, pw: p.width, ph: p.height });
                    if (fit.rotOk && (p.width !== p.height || !fit.normalOk)) candidates.push({ rot: true, pw: p.height, ph: p.width });

                    var sameDimCount = 0;
                    for (var m = 0; m < localPool.length; m++) {
                        if (Math.abs(localPool[m].width - p.width) <= EPS && Math.abs(localPool[m].height - p.height) <= EPS) {
                            sameDimCount++;
                        }
                    }

                    for (var cIdx = 0; cIdx < candidates.length; cIdx++) {
                        var c = candidates[cIdx];
                        var exactW = Math.abs(node.width - c.pw) <= EPS;
                        var exactH = Math.abs(node.height - c.ph) <= EPS;
                        var remW = roundClean(node.width - c.pw);
                        var remH = roundClean(node.height - c.ph);

                        var colsW = Math.min(sameDimCount, Math.floor((node.width + kerf + EPS) / (c.pw + kerf)));
                        var rowsH = Math.min(sameDimCount, Math.floor((node.height + kerf + EPS) / (c.ph + kerf)));
                        var wUtil = (colsW * c.pw) / node.width;
                        var hUtil = (rowsH * c.ph) / node.height;

                        var siblingFitsRight = false;
                        var siblingFitsTop = false;
                        var sameHeightWidthSum = c.pw;
                        var sameWidthHeightSum = c.ph;
                        var leftW = roundClean(node.width - c.pw - kerf);
                        var leftH = roundClean(node.height - c.ph - kerf);

                        for (var k = 0; k < localPool.length; k++) {
                            if (k === i) continue;
                            var sp = localPool[k];
                            if (leftW > EPS) {
                                var fR = canFit(sp, leftW, node.height, stock.orientation);
                                if (fR.normalOk || fR.rotOk) siblingFitsRight = true;
                                if (fR.normalOk && Math.abs(sp.height - c.ph) <= EPS && sameHeightWidthSum + kerf + sp.width <= node.width + EPS) {
                                    sameHeightWidthSum += sp.width;
                                } else if (fR.rotOk && Math.abs(sp.width - c.ph) <= EPS && sameHeightWidthSum + kerf + sp.height <= node.width + EPS) {
                                    sameHeightWidthSum += sp.height;
                                }
                            }
                            if (leftH > EPS) {
                                var fT = canFit(sp, node.width, leftH, stock.orientation);
                                if (fT.normalOk || fT.rotOk) siblingFitsTop = true;
                                if (fT.normalOk && Math.abs(sp.width - c.pw) <= EPS && sameWidthHeightSum + kerf + sp.height <= node.height + EPS) {
                                    sameWidthHeightSum += sp.height;
                                } else if (fT.rotOk && Math.abs(sp.height - c.pw) <= EPS && sameWidthHeightSum + kerf + sp.width <= node.height + EPS) {
                                    sameWidthHeightSum += sp.width;
                                }
                            }
                        }

                        var stripRowUtil = sameHeightWidthSum / node.width;
                        var stripColUtil = sameWidthHeightSum / node.height;
                        var pairBonus = (siblingFitsRight ? 50000000 : 0) + (siblingFitsTop ? 50000000 : 0);

                        var trimPenalty = 0;
                        if (leftW > EPS && leftW < minTrim - EPS) trimPenalty += 25000000;
                        if (leftH > EPS && leftH < minTrim - EPS) trimPenalty += 25000000;

                        var score = 0;
                        if (exactW && exactH) {
                            score = -1e13;
                        } else if (exactW || exactH) {
                            score = -1e11 - (c.pw * c.ph) * 100 + trimPenalty;
                        } else if (scoreMode === 0) {
                            score = -(pairBonus + Math.max(stripRowUtil, stripColUtil, wUtil, hUtil) * 8000000 + (c.pw * c.ph) * 10) + trimPenalty;
                        } else if (scoreMode === 1) {
                            score = -(pairBonus + Math.max(stripRowUtil, wUtil) * 10000000 + (c.pw * c.ph) * 10) + trimPenalty;
                        } else if (scoreMode === 2) {
                            score = -(pairBonus + Math.max(stripColUtil, hUtil) * 10000000 + (c.pw * c.ph) * 10) + trimPenalty;
                        } else {
                            score = Math.min(remW, remH) * 500 - (c.pw * c.ph) + trimPenalty;
                        }

                        if (score < bestScore) {
                            bestScore = score;
                            bestIdx = i;
                            bestRotated = c.rot;
                        }
                    }
                }

                if (bestIdx === -1) return;

                var chosen = localPool.splice(bestIdx, 1)[0];
                var pw = bestRotated ? chosen.height : chosen.width;
                var ph = bestRotated ? chosen.width : chosen.height;
                var dw = roundClean(node.width - pw);
                var dh = roundClean(node.height - ph);

                var remSameH = 1;
                var remSameW = 1;
                for (var idx2 = 0; idx2 < localPool.length; idx2++) {
                    var p2 = localPool[idx2];
                    var f2 = canFit(p2, node.width, node.height, stock.orientation);
                    if ((f2.normalOk && Math.abs(p2.height - ph) <= EPS) || (f2.rotOk && Math.abs(p2.width - ph) <= EPS)) remSameH++;
                    if ((f2.normalOk && Math.abs(p2.width - pw) <= EPS) || (f2.rotOk && Math.abs(p2.height - pw) <= EPS)) remSameW++;
                }

                var colsChosen = Math.min(remSameH, Math.floor((node.width + kerf + EPS) / (pw + kerf)));
                var rowsChosen = Math.min(remSameW, Math.floor((node.height + kerf + EPS) / (ph + kerf)));
                var wUtilChosen = (colsChosen * pw) / node.width;
                var hUtilChosen = (rowsChosen * ph) / node.height;

                var splitAlongXFirst = true;
                if (cutPref === 1) {
                    splitAlongXFirst = false;
                } else if (cutPref === 2) {
                    splitAlongXFirst = true;
                } else if (colsChosen >= 2 && wUtilChosen >= hUtilChosen) {
                    splitAlongXFirst = false;
                } else if (rowsChosen >= 2 && hUtilChosen > wUtilChosen) {
                    splitAlongXFirst = true;
                } else if (splitRule === 0) {
                    splitAlongXFirst = (dw < dh);
                } else if (splitRule === 1) {
                    splitAlongXFirst = (dw >= dh);
                } else {
                    var maxAreaXFirst = Math.max(Math.max(0, node.width - pw - kerf) * node.height, pw * Math.max(0, node.height - ph - kerf));
                    var maxAreaYFirst = Math.max(node.width * Math.max(0, node.height - ph - kerf), Math.max(0, node.width - pw - kerf) * ph);
                    splitAlongXFirst = (maxAreaXFirst >= maxAreaYFirst);
                }

                var nextChildren = placePartInNode(node, chosen, pw, ph, bestRotated, splitAlongXFirst, stock.orientation, tiles, cuts, nextTileIdRef);
                for (var nc = 0; nc < nextChildren.length; nc++) {
                    packNode(nextChildren[nc]);
                }
            }

            packNode(startNode);
            return finalizeAttempt(tiles, cuts, localPool.concat(ignoredPool));
        }

        // Compare two candidate single-sheet attempts according to optimizationPriority
        function isBetterSheetAttempt(cand, best, maxAchievableArea) {
            if (!best) return true;

            if (cand.remaining.length === 0 && best.remaining.length > 0) return true;
            if (cand.remaining.length > 0 && best.remaining.length === 0) return false;

            if (priority === 1) {
                var areaTol = Math.max(1e-3, maxAchievableArea * 0.005);
                var candNearMax = (maxAchievableArea - cand.usedArea) <= areaTol;
                var bestNearMax = (maxAchievableArea - best.usedArea) <= areaTol;
                if (candNearMax && !bestNearMax) return true;
                if (!candNearMax && bestNearMax) return false;
                if (candNearMax && bestNearMax) {
                    if (cand.cuts.length !== best.cuts.length) return cand.cuts.length < best.cuts.length;
                    if (Math.abs(cand.cutLength - best.cutLength) > 1e-2) return cand.cutLength < best.cutLength;
                    if (Math.abs(cand.usedArea - best.usedArea) > 1e-3) return cand.usedArea > best.usedArea;
                    return cand.maxOffcutArea > best.maxOffcutArea;
                }
            }

            if (Math.abs(cand.usedArea - best.usedArea) > 1e-3) {
                return cand.usedArea > best.usedArea;
            }
            if (cand.nbrFinal !== best.nbrFinal) {
                return cand.nbrFinal > best.nbrFinal;
            }
            if (cand.cuts.length !== best.cuts.length) {
                return cand.cuts.length < best.cuts.length;
            }
            if (Math.abs(cand.cutLength - best.cutLength) > 1e-2) {
                return cand.cutLength < best.cutLength;
            }
            return cand.maxOffcutArea > best.maxOffcutArea;
        }

        // Run all solver strategies on a single stock sheet and return the best attempt
        function optimizeSingleSheet(stock, remainingPanels) {
            var attempts = [];

            var allowHStrips = (cutPref === 0 || cutPref === 1);
            var allowVStrips = (cutPref === 0 || cutPref === 2);

            // 1a. Pure 2-Stage Strip strategies (fillRemainder = false) -> cleanest workshop layouts & fewest cuts
            for (var sMode = 0; sMode < 4; sMode++) {
                if (allowHStrips) {
                    attempts.push(packByStrips(stock, remainingPanels, true, sMode, false, false));
                    attempts.push(packByStrips(stock, remainingPanels, true, sMode, true, false));
                }
                if (allowVStrips) {
                    attempts.push(packByStrips(stock, remainingPanels, false, sMode, false, false));
                    attempts.push(packByStrips(stock, remainingPanels, false, sMode, true, false));
                }
            }

            // 1b. Hybrid 3-Stage Strip strategies (fillRemainder = true) -> packs remaining strip ends when needed
            for (var sMode2 = 0; sMode2 < 4; sMode2++) {
                if (allowHStrips) {
                    attempts.push(packByStrips(stock, remainingPanels, true, sMode2, false, true));
                    attempts.push(packByStrips(stock, remainingPanels, true, sMode2, true, true));
                }
                if (allowVStrips) {
                    attempts.push(packByStrips(stock, remainingPanels, false, sMode2, false, true));
                    attempts.push(packByStrips(stock, remainingPanels, false, sMode2, true, true));
                }
            }

            // 2. Recursive Guillotine Tree strategies (6 sort orders x 3 split rules x 4 score modes)
            for (var sortM = 0; sortM < 6; sortM++) {
                for (var splitR = 0; splitR < 3; splitR++) {
                    for (var scoreM = 0; scoreM < 4; scoreM++) {
                        if (sortM >= 3 && splitR === 2) continue;
                        attempts.push(packRecursiveGuillotine(stock, remainingPanels, sortM, splitR, scoreM));
                    }
                }
            }

            var maxArea = 0;
            for (var a = 0; a < attempts.length; a++) {
                if (attempts[a].usedArea > maxArea) maxArea = attempts[a].usedArea;
            }

            var best = null;
            for (var b = 0; b < attempts.length; b++) {
                if (isBetterSheetAttempt(attempts[b], best, maxArea)) {
                    best = attempts[b];
                }
            }
            return best;
        }

        // Convert a single sheet's bestAttempt + stock into a Mosaic object
        function buildMosaicObject(stock, bestAttempt) {
            var tiles = bestAttempt.tiles;
            var cuts = bestAttempt.cuts;
            var usedArea = roundClean(bestAttempt.usedArea);
            var stockArea = roundClean(stock.width * stock.height);

            var nbrFinal = 0;
            var nbrWasted = 0;
            var mosaicPanelsMap = {};
            var mosaicEdgeBands = {};

            tiles.forEach(function (t) {
                if (!t.hasChildren) {
                    if (t.final) {
                        nbrFinal++;
                        if (!mosaicPanelsMap[t.requestObjId]) {
                            mosaicPanelsMap[t.requestObjId] = {
                                requestObjId: t.requestObjId,
                                width: t.rotated ? t.height : t.width,
                                height: t.rotated ? t.width : t.height,
                                label: t.label,
                                count: 0
                            };
                        }
                        mosaicPanelsMap[t.requestObjId].count++;

                        if (hasEdgeBanding && t.edge) {
                            var origW = t.rotated ? t.height : t.width;
                            var origH = t.rotated ? t.width : t.height;
                            if (t.edge.top) mosaicEdgeBands[t.edge.top] = roundClean((mosaicEdgeBands[t.edge.top] || 0) + origW);
                            if (t.edge.bottom) mosaicEdgeBands[t.edge.bottom] = roundClean((mosaicEdgeBands[t.edge.bottom] || 0) + origW);
                            if (t.edge.left) mosaicEdgeBands[t.edge.left] = roundClean((mosaicEdgeBands[t.edge.left] || 0) + origH);
                            if (t.edge.right) mosaicEdgeBands[t.edge.right] = roundClean((mosaicEdgeBands[t.edge.right] || 0) + origH);
                        }
                    } else {
                        nbrWasted++;
                    }
                }
            });

            return {
                requestStockId: stock.requestObjId,
                stockLabel: stock.label,
                material: stock.rawMaterial,
                usedArea: usedArea,
                wastedArea: roundClean(Math.max(0, stockArea - usedArea)),
                usedAreaRatio: stockArea > 0 ? (usedArea / stockArea) : 0,
                cuts: cuts,
                cutLength: roundClean(bestAttempt.cutLength),
                nbrFinalPanels: nbrFinal,
                nbrWastedPanels: nbrWasted,
                edgeBands: mosaicEdgeBands,
                panels: Object.values(mosaicPanelsMap),
                tiles: tiles
            };
        }

        // Sort available stock sheets according to optimizationPriority
        if (priority === 2) {
            availStocks.sort(function (a, b) { return (a.area - b.area) || (a.requestObjId - b.requestObjId); });
        } else {
            availStocks.sort(function (a, b) { return (b.area - a.area) || (a.requestObjId - b.requestObjId); });
        }

        var mosaics = [];
        var remainingPanels = reqPanels.slice();

        if (useSingleStock) {
            var bestSingleStock = null;
            var bestSingleAttempt = null;
            var testedKeys = {};

            for (var uIdx = 0; uIdx < availStocks.length; uIdx++) {
                var candStock = availStocks[uIdx];
                var sKey = candStock.requestObjId + '_' + candStock.width + 'x' + candStock.height + '_' + candStock.material + '_' + candStock.orientation;
                if (testedKeys[sKey]) continue;
                testedKeys[sKey] = true;

                var hasMatching = remainingPanels.some(function (p) {
                    if (considerMaterial && p.material !== candStock.material) return false;
                    var f = canFit(p, candStock.width, candStock.height, candStock.orientation);
                    return f.normalOk || f.rotOk;
                });
                if (!hasMatching) continue;

                var attemptSingle = optimizeSingleSheet(candStock, remainingPanels);
                if (!bestSingleAttempt) {
                    bestSingleStock = candStock;
                    bestSingleAttempt = attemptSingle;
                } else {
                    var morePanels = attemptSingle.nbrFinal !== bestSingleAttempt.nbrFinal ? (attemptSingle.nbrFinal > bestSingleAttempt.nbrFinal) : null;
                    var moreArea = Math.abs(attemptSingle.usedArea - bestSingleAttempt.usedArea) > 1e-3 ? (attemptSingle.usedArea > bestSingleAttempt.usedArea) : null;
                    var candWasted = candStock.area - attemptSingle.usedArea;
                    var bestWasted = bestSingleStock.area - bestSingleAttempt.usedArea;

                    var takeCand = false;
                    if (moreArea !== null) {
                        takeCand = moreArea;
                    } else if (morePanels !== null) {
                        takeCand = morePanels;
                    } else if (Math.abs(candWasted - bestWasted) > 1e-3) {
                        takeCand = candWasted < bestWasted;
                    } else {
                        takeCand = attemptSingle.cuts.length < bestSingleAttempt.cuts.length;
                    }

                    if (takeCand) {
                        bestSingleStock = candStock;
                        bestSingleAttempt = attemptSingle;
                    }
                }
            }

            if (bestSingleStock && bestSingleAttempt && bestSingleAttempt.nbrFinal > 0) {
                remainingPanels = bestSingleAttempt.remaining;
                mosaics.push(buildMosaicObject(bestSingleStock, bestSingleAttempt));
            }
        } else {
            var unusedStocks = availStocks.slice();

            while (remainingPanels.length > 0 && unusedStocks.length > 0) {
                var distinctIndices = [];
                var seenType = {};
                for (var sIdx = 0; sIdx < unusedStocks.length; sIdx++) {
                    var st = unusedStocks[sIdx];
                    var tKey = st.requestObjId + '_' + st.width + 'x' + st.height + '_' + st.material + '_' + st.orientation;
                    if (!seenType[tKey]) {
                        seenType[tKey] = true;
                        distinctIndices.push(sIdx);
                    }
                }

                var chosenStockIdx = -1;
                var chosenAttempt = null;

                for (var d = 0; d < distinctIndices.length; d++) {
                    var idxInUnused = distinctIndices[d];
                    var stock = unusedStocks[idxInUnused];

                    var canFitAny = remainingPanels.some(function (p) {
                        if (considerMaterial && p.material !== stock.material) return false;
                        var fit = canFit(p, stock.width, stock.height, stock.orientation);
                        return fit.normalOk || fit.rotOk;
                    });
                    if (!canFitAny) continue;

                    var attempt = optimizeSingleSheet(stock, remainingPanels);
                    if (!attempt || attempt.nbrFinal === 0) continue;

                    if (!chosenAttempt) {
                        chosenStockIdx = idxInUnused;
                        chosenAttempt = attempt;
                    } else {
                        var prevStock = unusedStocks[chosenStockIdx];
                        var compatRemainingBefore = remainingPanels.filter(function (p) {
                            return !considerMaterial || p.material === stock.material;
                        }).length;
                        var candFinishesMaterial = (attempt.nbrFinal === compatRemainingBefore);
                        var prevCompatBefore = remainingPanels.filter(function (p) {
                            return !considerMaterial || p.material === prevStock.material;
                        }).length;
                        var prevFinishesMaterial = (chosenAttempt.nbrFinal === prevCompatBefore);

                        var betterStockChoice = false;
                        if (priority === 2) {
                            if (stock.area < prevStock.area - EPS) betterStockChoice = true;
                            else if (Math.abs(stock.area - prevStock.area) <= EPS) {
                                betterStockChoice = isBetterSheetAttempt(attempt, chosenAttempt, Math.max(attempt.usedArea, chosenAttempt.usedArea));
                            }
                        } else if (candFinishesMaterial && prevFinishesMaterial && stock.material === prevStock.material) {
                            var candWaste = stock.area - attempt.usedArea;
                            var prevWaste = prevStock.area - chosenAttempt.usedArea;
                            if (Math.abs(candWaste - prevWaste) > 1e-3) {
                                betterStockChoice = candWaste < prevWaste;
                            } else {
                                betterStockChoice = attempt.cuts.length < chosenAttempt.cuts.length;
                            }
                        } else {
                            var candRatio = attempt.usedArea / stock.area;
                            var prevRatio = chosenAttempt.usedArea / prevStock.area;
                            if (Math.abs(candRatio - prevRatio) > 0.02) {
                                betterStockChoice = candRatio > prevRatio;
                            } else {
                                betterStockChoice = isBetterSheetAttempt(attempt, chosenAttempt, Math.max(attempt.usedArea, chosenAttempt.usedArea));
                            }
                        }

                        if (betterStockChoice) {
                            chosenStockIdx = idxInUnused;
                            chosenAttempt = attempt;
                        }
                    }
                }

                if (chosenStockIdx === -1 || !chosenAttempt) break;

                var usedStock = unusedStocks.splice(chosenStockIdx, 1)[0];
                remainingPanels = chosenAttempt.remaining;
                mosaics.push(buildMosaicObject(usedStock, chosenAttempt));
            }
        }

        var totalUsedArea = 0;
        var totalWastedArea = 0;
        var totalNbrCuts = 0;
        var totalCutLength = 0;
        var globalEdgeBands = {};
        var usedStockMap = {};

        mosaics.forEach(function (m) {
            totalUsedArea = roundClean(totalUsedArea + m.usedArea);
            totalWastedArea = roundClean(totalWastedArea + m.wastedArea);
            totalNbrCuts += m.cuts.length;
            totalCutLength = roundClean(totalCutLength + m.cutLength);
            Object.keys(m.edgeBands || {}).forEach(function (k) {
                globalEdgeBands[k] = roundClean((globalEdgeBands[k] || 0) + m.edgeBands[k]);
            });
            var sid = m.requestStockId;
            if (!usedStockMap[sid]) {
                usedStockMap[sid] = {
                    requestObjId: sid,
                    width: m.tiles[0].width,
                    height: m.tiles[0].height,
                    label: m.stockLabel,
                    material: m.material,
                    count: 0,
                    enabled: true
                };
            }
            usedStockMap[sid].count++;
        });

        var noFitMap = {};
        remainingPanels.forEach(function (p) {
            if (!noFitMap[p.requestObjId]) {
                noFitMap[p.requestObjId] = {
                    id: p.requestObjId,
                    width: p.width,
                    height: p.height,
                    label: p.label,
                    material: p.rawMaterial,
                    count: 0
                };
            }
            noFitMap[p.requestObjId].count++;
        });

        var totalArea = roundClean(totalUsedArea + totalWastedArea);
        var elapsed = Math.max(15, Date.now() - startTime);
        return {
            id: 'sol-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            taskId: 'task-' + Date.now(),
            version: '1.126',
            elapsedTime: elapsed,
            solutionElapsedTime: elapsed,
            totalUsedArea: totalUsedArea,
            totalWastedArea: totalWastedArea,
            totalUsedAreaRatio: totalArea > 0 ? (totalUsedArea / totalArea) : 0,
            totalNbrCuts: totalNbrCuts,
            totalCutLength: totalCutLength,
            edgeBands: globalEdgeBands,
            request: request,
            mosaics: mosaics,
            panels: Object.values(panelSummaryMap),
            usedStockPanels: Object.values(usedStockMap),
            noFitPanels: Object.values(noFitMap)
        };
    }

    // Expose window.android bridge matching com.cutlistoptimizer v1.126
    window.android = {
        compute: function (jsonDataStr) {
            try {
                var req = JSON.parse(jsonDataStr);
                var taskId = 'task-' + Date.now();
                var solution = solveCutList(req);
                solution.taskId = taskId;
                tasksStore[taskId] = {
                    initPercentage: 100,
                    percentageDone: 100,
                    status: 'FINISHED',
                    solution: solution
                };
                return JSON.stringify({ statusCode: 0, taskId: taskId });
            } catch (e) {
                console.error("Native solver error:", e);
                return JSON.stringify({ statusCode: 4, taskId: null });
            }
        },
        getTaskStatus: function (taskId) {
            var t = tasksStore[taskId];
            if (!t) {
                return JSON.stringify({ initPercentage: 100, percentageDone: 100, status: 'FINISHED', solution: null });
            }
            return JSON.stringify(t);
        },
        stopTask: function (taskId) {
            if (tasksStore[taskId]) {
                tasksStore[taskId].status = 'FINISHED';
            }
        },
        getAppVersion: function () { return "1.126"; },
        getBuildTimestamp: function () { return "2026-11-08"; },
        getDeviceId: function () { return "local-android-device-pro"; },
        isFull: function () { return true; },
        getNbrTotalCalculations: function () { return 0; },
        getNbrWeekCalculations: function () { return 0; },
        getNbrDayCalculations: function () { return 0; },
        getWeekCalculationsThreshold: function () { return 999999; },
        getDayCalculationsThreshold: function () { return 999999; },
        getTotalCalculationsThreshold: function () { return 999999; },
        setClientId: function () {},
        setUserAccessToken: function () {},
        setSubscriptionPlanLevel: function () {},
        setModalVisible: function () {},
        onModalOpen: function () {},
        onModalClose: function () {},
        onPlanChoice: function () {},
        donate: function () {
            showInPageNotice("النسخة الاحترافية (Pro) مفعلة مجاناً بالكامل!", false);
        },
        consumeIap: function () {},
        signinWithGoogle: function () {
            showInPageNotice("قاعدة البيانات المحلية مفعلة بدون الحاجة لحساب خارجي", false);
        },
        logout: function () {},
        showToast: function (msg) {
            showInPageNotice(msg, false);
        },
        showProgressDialog: function (msg) {
            showInPageNotice(msg, false);
        },
        dismissProgressDialog: function () {},
        saveCsv: function (csvContent, filename) {
            try {
                var fname = filename || 'cutlist.csv';
                if (window.NativeSaver && typeof window.NativeSaver.pickSaveText === 'function') {
                    window.NativeSaver.pickSaveText(csvContent, fname, 'text/csv');
                } else {
                    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
                    download(blob, fname, 'text/csv');
                    showInPageNotice("تم حفظ ملف CSV: " + fname, false);
                }
            } catch (e) {
                console.error("saveCsv error:", e);
            }
        },
        saveImage: function (imgDataUrl, filename) {
            try {
                var fname = filename || 'cutlist.jpeg';
                if (window.NativeSaver && typeof window.NativeSaver.pickSaveDataUrl === 'function') {
                    window.NativeSaver.pickSaveDataUrl(imgDataUrl, fname, 'image/jpeg');
                } else {
                    download(imgDataUrl, fname, 'image/jpeg');
                    showInPageNotice("تم حفظ الصورة: " + fname, false);
                }
            } catch (e) {
                console.error("saveImage error:", e);
            }
        },
        savePdf: function (pdfDataUrl, filename) {
            try {
                var fname = filename || 'cutlist.pdf';
                if (window.NativeSaver && typeof window.NativeSaver.pickSaveDataUrl === 'function') {
                    window.NativeSaver.pickSaveDataUrl(pdfDataUrl, fname, 'application/pdf');
                } else {
                    download(pdfDataUrl, fname, 'application/pdf');
                    showInPageNotice("تم حفظ ملف PDF: " + fname, false);
                }
            } catch (e) {
                console.error("savePdf error:", e);
            }
        }
    };

    try {
        localStorage.setItem("isFull", "true");
        localStorage.setItem("useLocalStorageAsRepository", "true");
    } catch (e) {}
})();
