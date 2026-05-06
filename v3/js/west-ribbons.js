// WEST.ribbons — shared ribbon SVG renderer.
//
// Hunter-show ribbon colors: 1=blue, 2=red, 3=yellow, 4=white/grey,
// 5=pink, 6=green, 7=purple, 8=brown, 9=grey, 10=light blue,
// 11=fuchsia, 12=lime green. Square 32×32 SVG with rosette petals
// + center number. Returns empty string for unknown / out-of-range
// places.
//
// Used by:
//   • west-flat.js (hunter flat results — pinned ribbons row)
//   • west-jumper-templates.js (FINAL classes, places 1-12)
//   • west-hunter-templates.js (FINAL hunter classes, capped at
//     class.ribbon_count from the .cls header)
//
// Lifted out of west-flat.js so consumers don't need to import the
// whole hunter-flat module just for the SVG primitive (Bill 2026-05-06,
// "option 3 — own module"). west-flat.js re-exports the same function
// for backward compat.

(function (root) {
  'use strict';
  var WEST = root.WEST = root.WEST || {};
  WEST.ribbons = WEST.ribbons || {};

  var COLORS = {
    1:  { o: '#0a3d8f', i: '#3a7bd5', f: '#e8f0fb', t: '#0a3d8f' },
    2:  { o: '#8b0000', i: '#cc2222', f: '#fbe8e8', t: '#8b0000' },
    3:  { o: '#9a7800', i: '#d4a800', f: '#fdf6d8', t: '#7a5e00' },
    4:  { o: '#888',    i: '#bbb',    f: '#f4f4f4', t: '#555'    },
    5:  { o: '#ad1457', i: '#e91e8c', f: '#fde8f3', t: '#ad1457' },
    6:  { o: '#1a6b2a', i: '#2ea043', f: '#e8f5eb', t: '#1a6b2a' },
    7:  { o: '#4a2d8e', i: '#7c52cc', f: '#f0ebfb', t: '#4a2d8e' },
    8:  { o: '#5c3317', i: '#8b5e3c', f: '#f5ede6', t: '#5c3317' },
    9:  { o: '#666',    i: '#999',    f: '#f0f0f0', t: '#444'    },
    10: { o: '#1565a8', i: '#5ba3e0', f: '#e3f2fd', t: '#1565a8' },
    11: { o: '#b0006a', i: '#e8409a', f: '#fce4f2', t: '#8b0052' },
    12: { o: '#3d7a00', i: '#7ec800', f: '#f0fce0', t: '#2d5c00' },
  };

  WEST.ribbons.svg = function (placeNum) {
    var n = parseInt(placeNum, 10);
    if (!isFinite(n) || n < 1) return '';
    var c = COLORS[n];
    if (!c) return '';
    var petals = '';
    for (var i = 0; i < 12; i++) {
      var a = i * 30, r = 12, cx = 16, cy = 16;
      var rad = a * Math.PI / 180;
      var x = (cx + r * Math.sin(rad)).toFixed(1);
      var y = (cy - r * Math.cos(rad)).toFixed(1);
      petals += '<ellipse cx="' + x + '" cy="' + y +
        '" rx="4.5" ry="2.6" fill="' + c.o +
        '" transform="rotate(' + a + ',' + x + ',' + y + ')"/>';
    }
    var circles = '<circle cx="16" cy="16" r="10" fill="' + c.i +
      '"/><circle cx="16" cy="16" r="8" fill="' + c.f + '"/>';
    var fs = n >= 10 ? '10' : '12';
    return '<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">'
      + petals + circles
      + '<text x="16" y="16" text-anchor="middle" dominant-baseline="central"'
      + ' font-family="serif" font-weight="bold" font-size="' + fs + '" fill="' + c.t + '">'
      + n + '</text></svg>';
  };
})(typeof window !== 'undefined' ? window : global);
