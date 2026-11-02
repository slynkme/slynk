// SVG drawings as Inkscape and Illustrator write them, built in code. Every value is invented:
// "Example Author", "Example Corp", the user "exampleuser", dates in June 2024 (UTC).
import { toBase64 } from '../../src/strip/svgscan.ts'
import { photoWithGps } from './docfixtures.ts'
import { utf8 } from './fixtures.ts'

/** Inkscape 1.3's way: its namespaces declared on the root, the page's settings, metadata, layers and an image linked from the maker's own folder. */
export const INKSCAPE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->

<svg
   width="210mm"
   height="148mm"
   viewBox="0 0 210 148"
   version="1.1"
   id="svg1"
   inkscape:version="1.3.2 (091e20e, 2023-11-25, custom)"
   sodipodi:docname="Example plan.svg"
   inkscape:export-filename="/home/exampleuser/Pictures/Example plan.png"
   inkscape:export-xdpi="96"
   inkscape:export-ydpi="96"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:xlink="http://www.w3.org/1999/xlink"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:dc="http://purl.org/dc/elements/1.1/">
  <sodipodi:namedview
     id="namedview1"
     pagecolor="#ffffff"
     bordercolor="#000000"
     borderopacity="0.25"
     inkscape:showpageshadow="2"
     inkscape:pageopacity="0.0"
     inkscape:pagecheckerboard="0"
     inkscape:deskcolor="#d1d1d1"
     inkscape:document-units="mm"
     inkscape:zoom="0.7"
     inkscape:cx="396.42857"
     inkscape:cy="280.71429"
     inkscape:window-width="1920"
     inkscape:window-height="1011"
     inkscape:window-x="0"
     inkscape:window-y="32"
     inkscape:window-maximized="1"
     inkscape:current-layer="layer1" />
  <defs
     id="defs1">
    <linearGradient
       inkscape:collect="always"
       id="gradient1"
       x1="40"
       y1="20"
       x2="160"
       y2="100"
       gradientUnits="userSpaceOnUse">
      <stop
         style="stop-color:#4a90d9;stop-opacity:1"
         offset="0"
         id="stop1" />
      <stop
         style="stop-color:#8b7bff;stop-opacity:1"
         offset="1"
         id="stop2" />
    </linearGradient>
    <inkscape:perspective
       sodipodi:type="inkscape:persp3d"
       inkscape:vp_x="0 : 74 : 1"
       inkscape:vp_y="0 : 1000 : 0"
       inkscape:vp_z="210 : 74 : 1"
       inkscape:persp3d-origin="105 : 49.333333 : 1"
       id="perspective1" />
  </defs>
  <metadata
     id="metadata1">
    <rdf:RDF>
      <cc:Work
         rdf:about="">
        <dc:format>image/svg+xml</dc:format>
        <dc:type
           rdf:resource="http://purl.org/dc/dcmitype/StillImage" />
        <dc:title>Example floor plan</dc:title>
        <dc:creator>
          <cc:Agent>
            <dc:title>Example Author</dc:title>
          </cc:Agent>
        </dc:creator>
        <dc:rights>
          <cc:Agent>
            <dc:title>Example Corp</dc:title>
          </cc:Agent>
        </dc:rights>
        <dc:date>2024-06-12</dc:date>
        <dc:subject>
          <rdf:Bag>
            <rdf:li>example</rdf:li>
            <rdf:li>floor plan</rdf:li>
          </rdf:Bag>
        </dc:subject>
        <cc:license
           rdf:resource="http://creativecommons.org/licenses/by/4.0/" />
      </cc:Work>
    </rdf:RDF>
  </metadata>
  <g
     inkscape:label="Example layer"
     inkscape:groupmode="layer"
     id="layer1">
    <rect
       style="fill:url(#gradient1);stroke:#1d1d1b;stroke-width:1.5"
       id="rect1"
       width="120"
       height="80"
       x="40"
       y="20"
       ry="6" />
    <path
       sodipodi:type="star"
       style="fill:#e94e1b;stroke:none"
       id="path1"
       inkscape:flatsided="false"
       sodipodi:sides="5"
       sodipodi:cx="180"
       sodipodi:cy="40"
       sodipodi:r1="20"
       sodipodi:r2="8"
       sodipodi:arg1="-1.5707963"
       sodipodi:arg2="-0.9424778"
       inkscape:rounded="0"
       inkscape:randomized="0"
       d="m 180,20 4.7,13.53 14.32,0.29 -11.41,8.65 4.15,13.71 L 180,48 168.24,56.18 172.39,42.47 160.98,33.82 175.3,33.53 Z" />
    <text
       xml:space="preserve"
       style="font-size:9px;font-family:sans-serif;fill:#1d1d1b"
       x="44"
       y="120"
       id="text1"><tspan
         sodipodi:role="line"
         id="tspan1"
         x="44"
         y="120">Example floor plan</tspan></text>
    <image
       width="30"
       height="20"
       preserveAspectRatio="none"
       xlink:href="file:///home/exampleuser/Pictures/Example%20photo.jpg"
       sodipodi:absref="/home/exampleuser/Pictures/Example photo.jpg"
       id="image1"
       x="170"
       y="110" />
  </g>
</svg>
`

/** A JPEG with GPS, camera and dates (fixtures.ts), as an Illustrator file embeds it: base64 with a line break every 76 characters. */
export const EMBEDDED_JPEG = photoWithGps()
const wrapped = (b64: string) => b64.replace(/.{76}/g, '$&\n')

/** Illustrator's way: its generator comment, a DOCTYPE naming its namespaces, Save for Web and XMP metadata, its private copy of the artwork, and an embedded photo. */
export function illustrator(embedded = EMBEDDED_JPEG): string {
  const bom = String.fromCodePoint(0xfeff)
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
	<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
	<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">
	<!ENTITY ns_graphs "http://ns.adobe.com/Graphs/1.0/">
	<!ENTITY ns_vars "http://ns.adobe.com/Variables/1.0/">
	<!ENTITY ns_imrep "http://ns.adobe.com/ImageReplacement/1.0/">
	<!ENTITY ns_sfw "http://ns.adobe.com/SaveForWeb/1.0/">
	<!ENTITY ns_custom "http://ns.adobe.com/GenericCustomNamespace/1.0/">
	<!ENTITY ns_adobe_xpath "http://ns.adobe.com/XPath/1.0/">
]>
<svg version="1.1" id="Layer_1" xmlns:x="&ns_extend;" xmlns:i="&ns_ai;" xmlns:graph="&ns_graphs;"
	 xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="200px"
	 height="120px" viewBox="0 0 200 120" style="enable-background:new 0 0 200 120;" xml:space="preserve">
<style type="text/css">
	.st0{fill:#E94E1B;}
	.st1{fill:none;stroke:#1D1D1B;stroke-width:4;stroke-miterlimit:10;}
</style>
<metadata>
	<sfw  xmlns="&ns_sfw;">
		<slices></slices>
		<sliceSourceBounds  bottomLeftOrigin="true" height="120" width="200" x="0" y="0"></sliceSourceBounds>
	</sfw>
	<?xpacket begin="${bom}" id="W5M0MpCehiHzreSzNTczkc9d"?>
	<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 9.0-c000 79.da4a7e5ef, 2022/11/27-09:35:03        ">
	 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
	  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"
	   xmp:CreatorTool="Adobe Illustrator 27.0 (Macintosh)" xmp:CreateDate="2024-06-12T18:30:00Z" xmpMM:DocumentID="xmp.did:0123456789abcdef">
	   <dc:creator><rdf:Seq><rdf:li>Example Author</rdf:li></rdf:Seq></dc:creator>
	   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Example logo</rdf:li></rdf:Alt></dc:title>
	   <xmpMM:History><rdf:Seq><rdf:li stEvt:action="saved" stEvt:when="2024-06-12T18:31:00Z" stEvt:softwareAgent="Adobe Illustrator 27.0 (Macintosh)"/></rdf:Seq></xmpMM:History>
	  </rdf:Description>
	 </rdf:RDF>
	</x:xmpmeta>
	<?xpacket end="w"?>
</metadata>
<switch>
	<foreignObject requiredExtensions="&ns_ai;" x="0" y="0" width="1" height="1">
		<i:pgfRef  xlink:href="#adobe_illustrator_pgf">
		</i:pgfRef>
	</foreignObject>
	<g i:extraneous="self">
		<rect x="10" y="10" class="st0" width="80" height="60"/>
		<circle class="st1" cx="140" cy="50" r="30"/>
		<image style="overflow:visible;" width="8" height="8" xlink:href="data:image/jpeg;base64,${wrapped(toBase64(embedded))}" transform="matrix(4 0 0 4 120 84)">
		</image>
	</g>
</switch>
<i:pgf  id="adobe_illustrator_pgf">
	<![CDATA[
	eJzsvWmTHLmRIPp9zfY/5Psgs+43YjbiPmSz5Bm7J8nU0ozWqEWzNraXGxxWVZOnCx4TiA8IVBExHvAXUWrLbd
	]]>
</i:pgf>
</svg>
`
}

/** A drawing with nothing to remove. */
export const PLAIN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M2 12h20M12 2v20" stroke="#000" stroke-width="2"/></svg>
`

export const bytes = (s: string) => utf8(s)
