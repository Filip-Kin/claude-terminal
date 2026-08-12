// Duck-in-the-Anthropic-burst PWA icon. Solid background (no transparency, so no
// white-box surprise on Android). Bigger burst. Real 🦆 emoji at the hub.
const CORAL = "#D97757";
const BG    = "#F4EFE7"; // warm Anthropic-ish cream
const CX = 256, CY = 256;

function ray(a:number, inner:number, outer:number, wb:number, wt:number){
  const p=[`M ${CX-wb/2} ${CY-inner}`,`L ${CX-wt/2} ${CY-outer+wt/2}`,
    `Q ${CX} ${CY-outer} ${CX+wt/2} ${CY-outer+wt/2}`,`L ${CX+wb/2} ${CY-inner}`,
    `Q ${CX} ${CY-inner+wb/2} ${CX-wb/2} ${CY-inner}`,`Z`].join(" ");
  return `<path d="${p}" transform="rotate(${a} ${CX} ${CY})"/>`;
}
// Bigger, bolder burst. Kept within the maskable safe zone (content < ~80% radius).
const N=16, lens=[196,168,182,168]; let rays="";
for(let i=0;i<N;i++) rays+=ray((360/N)*i,70,lens[i%lens.length],40,12)+"\n";

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${BG}"/>
  <g fill="${CORAL}">${rays}</g>
  <text x="256" y="270" font-size="232" text-anchor="middle" dominant-baseline="central">🦆</text>
</svg>`;
await Bun.write("icon.svg", svg);
console.log("ok");
