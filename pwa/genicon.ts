const CORAL = "#D97757";
const BEAK  = "#E8913A";
const CX = 256, CY = 256;

function ray(a:number, inner:number, outer:number, wb:number, wt:number){
  const p=[`M ${CX-wb/2} ${CY-inner}`,`L ${CX-wt/2} ${CY-outer+wt/2}`,
    `Q ${CX} ${CY-outer} ${CX+wt/2} ${CY-outer+wt/2}`,`L ${CX+wb/2} ${CY-inner}`,
    `Q ${CX} ${CY-inner+wb/2} ${CX-wb/2} ${CY-inner}`,`Z`].join(" ");
  return `<path d="${p}" transform="rotate(${a} ${CX} ${CY})"/>`;
}
const N=16, lens=[206,176,192,176]; let rays="";
for(let i=0;i<N;i++) rays+=ray((360/N)*i,78,lens[i%lens.length],30,9)+"\n";

const goose = `
  <g stroke="#E9C9B6" stroke-width="0">
    <!-- neck: short, tucked, curving down-left, stays inside burst -->
    <path d="M 252 288 C 260 328 246 356 214 366 L 178 352 C 172 324 176 300 186 280 C 206 298 234 300 252 288 Z" fill="#ffffff"/>
    <!-- head -->
    <circle cx="230" cy="216" r="84" fill="#ffffff"/>
    <!-- beak: open + honking up-right. Upper mandible -->
    <path d="M 298 188 Q 360 158 394 150 Q 372 186 348 208 Z" fill="${BEAK}"/>
    <!-- lower mandible (gap = open honk) -->
    <path d="M 306 224 Q 350 226 378 232 Q 344 250 320 250 Z" fill="${BEAK}"/>
    <!-- eye -->
    <circle cx="250" cy="196" r="11" fill="#1c140f"/>
    <!-- tiny highlight in eye -->
    <circle cx="254" cy="192" r="3.4" fill="#ffffff"/>
  </g>`;

const svg=(bg:string,pad:number)=>`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
${bg}
<g transform="translate(${pad} ${pad}) scale(${(512-2*pad)/512})">
<g fill="${CORAL}">${rays}</g>
${goose}
</g></svg>`;

await Bun.write("icon.svg", svg("",40));
await Bun.write("icon-maskable.svg", svg(`<rect width="512" height="512" fill="#F7F3EE"/>`,92));
console.log("ok");
