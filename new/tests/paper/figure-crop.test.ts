import { Result } from "effect"
import { describe, expect, it } from "vitest"
import type { ImageArtifact, Page, PixelBox } from "../../src/domain/index.ts"
import { FIGURE_CROP_REVIEW_PROMPT, FIGURE_CROP_REVIEW_PROMPT_V2, publicPrompt } from "../../src/domain/prompt-templates.ts"
import { buildFigureCropRequest, figureCropProblems, figureNeighbours, widenedFigureCrop } from "../../src/paper/figures/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import { pngBytes, stageLimits } from "./correction-fixtures.ts"

const pageOf = (width: number, height: number, pageNumber = 1): Page => {
  const page = contractFixture().extraction.pages[0]!
  return { ...page, pageNumber, width, height, image: { ...page.image, mediaType: "image/png", byteCount: pngBytes.byteLength } }
}
const box = (x: number, y: number, width: number, height: number): PixelBox => ({ coordinateSystem: "rendered-page-top-left-pixels", x, y, width, height })
const corrected = (x: number, y: number, width: number, height: number) => ({ verdict: "corrected", box: { x, y, width, height } })
const problemsOf = (result: ReturnType<typeof figureCropProblems>) => Result.isFailure(result) ? result.failure : []

// NASA "3-2-1 Pop!" page 3, run 994783e5-1036-471f-aa1f-88e9ea645fe5: the extractor's proposed regions and
// the Muse crop-review answers saved for them (attempt IDs in the comments). Five answers grew a single step
// into nearly the whole page; the old check accepted them because each one still contained its proposal.
const nasaPage = pageOf(2550, 3300, 3)
const nasaFigures = [
  { blockIndex: 2, box: { x: 300, y: 630, width: 220, height: 460 } },
  { blockIndex: 5, box: { x: 750, y: 670, width: 160, height: 570 } },
  { blockIndex: 8, box: { x: 965, y: 980, width: 380, height: 630 } },
  { blockIndex: 11, box: { x: 1400, y: 1020, width: 325, height: 1010 } },
  { blockIndex: 14, box: { x: 1705, y: 535, width: 435, height: 1095 } },
  { blockIndex: 18, box: { x: 320, y: 1875, width: 750, height: 760 } },
  { blockIndex: 19, box: { x: 1115, y: 2010, width: 350, height: 490 } },
]
const nasaCheck = (blockIndex: number, current?: PixelBox) => {
  const proposal = nasaFigures.find((figure) => figure.blockIndex === blockIndex)!.box
  const proposed = box(proposal.x, proposal.y, proposal.width, proposal.height)
  return { page: nasaPage, proposed, current: current ?? proposed, neighbours: figureNeighbours(nasaFigures, blockIndex) }
}

describe("figure crop review answers", () => {
  it.each([
    ["block 3 (58e883ad)", 2, corrected(270, 310, 1920, 2580), 59],
    ["block 6 (805bc787)", 5, corrected(270, 295, 1890, 2570), 58],
    ["block 9 (def82e50)", 8, corrected(270, 285, 1895, 2610), 59],
    ["block 15 (430a5bff)", 14, corrected(275, 310, 1885, 2570), 58],
    ["block 20 (d19f4ed4)", 19, corrected(260, 250, 1920, 2620), 60],
  ])("rejects the saved NASA page-3 answer that inflated %s into the whole page", (_name, blockIndex, answer, share) => {
    expect(problemsOf(figureCropProblems(nasaCheck(blockIndex), answer))).toEqual([
      expect.stringContaining(`covers ${share}% of the page`),
      expect.stringContaining("takes in 6 other figures' regions on this page"),
    ])
  })

  // OSHA 3491 "Hazard Pictograms" page 2, run 001b1ece-18a5-406a-9fa9-c04ab7082eb3: nine 165x165 pictograms in a
  // grid. The reviewer grew each one into a box of about half the page holding the others, and the old check
  // accepted every answer.
  const oshaPage = pageOf(1200, 2700, 2)
  const oshaFigures = [845, 1440, 1940].flatMap((y, row) => [135, 500, 870].map((x, column) => ({ blockIndex: 5 + row * 3 + column, box: { x, y, width: 165, height: 165 } })))
  const oshaCheck = (blockIndex: number, current?: PixelBox) => {
    const { x, y } = oshaFigures.find((figure) => figure.blockIndex === blockIndex)!.box
    const proposed = box(x, y, 165, 165)
    return { page: oshaPage, proposed, current: current ?? proposed, neighbours: figureNeighbours(oshaFigures, blockIndex) }
  }
  it.each([
    ["block 7 (c590090b)", 6, corrected(40, 870, 1120, 1510), 52, 8],
    ["block 8 (4c58f28d)", 7, corrected(48, 810, 1104, 1600), 55, 8],
    ["block 9 (4f8472d0)", 8, corrected(40, 870, 1120, 1530), 53, 8],
    ["block 10 (97de9226)", 9, corrected(45, 835, 1110, 1575), 54, 8],
    ["block 11 (5e7f5812)", 10, corrected(40, 920, 1120, 1510), 52, 8],
    ["block 13 (70058f06)", 12, corrected(45, 835, 1110, 1530), 52, 8],
    ["block 14 (4ea327b8)", 13, corrected(45, 875, 1110, 1590), 54, 8],
  ])("rejects the saved OSHA page-2 answer that grew %s into the pictogram grid", (_name, blockIndex, answer, share, others) => {
    expect(problemsOf(figureCropProblems(oshaCheck(blockIndex), answer))).toEqual([
      expect.stringContaining(`covers ${share}% of the page`),
      expect.stringContaining(`takes in ${others} other figures' regions on this page`),
    ])
  })

  it("catches an OSHA inflation just under half the page by the figures it takes in", () => {
    expect(problemsOf(figureCropProblems(oshaCheck(11), corrected(43, 930, 1114, 1435)))).toEqual([expect.stringContaining("takes in 5 other figures' regions on this page")])
    const block6 = box(128, 968, 180, 180)
    expect(figureCropProblems(oshaCheck(5), corrected(128, 968, 180, 180))).toEqual(Result.succeed({ _tag: "corrected", box: block6 }))
    expect(problemsOf(figureCropProblems(oshaCheck(5, block6), corrected(50, 780, 1100, 1570)))).toEqual([
      expect.stringContaining("covers 53% of the page"), expect.stringContaining("takes in 8 other figures' regions on this page"),
    ])
  })

  it("accepts the saved NASA corrections that stayed on their own figure", () => {
    const block12 = figureCropProblems(nasaCheck(11), corrected(1345, 985, 400, 1270))
    expect(block12).toEqual(Result.succeed({ _tag: "corrected", box: box(1345, 985, 400, 1270) }))
    expect(Result.isSuccess(figureCropProblems(nasaCheck(11, box(1345, 985, 400, 1270)), corrected(1340, 970, 380, 1300)))).toBe(true)
    expect(Result.isSuccess(figureCropProblems(nasaCheck(18), corrected(300, 2030, 770, 850)))).toBe(true)
    expect(figureCropProblems(nasaCheck(18, box(300, 2030, 770, 850)), { verdict: "confirmed", box: null })).toEqual(Result.succeed({ _tag: "confirmed" }))
    const pageFour = { page: pageOf(2550, 3300, 4), proposed: box(1505, 510, 535, 2160), current: box(1505, 510, 535, 2160), neighbours: [] }
    expect(Result.isSuccess(figureCropProblems(pageFour, corrected(1525, 500, 520, 2210)))).toBe(true)
  })

  it("allows a large box when the extractor already proposed one that large", () => {
    const page = pageOf(1000, 1000)
    const proposed = box(50, 50, 800, 800)
    expect(Result.isSuccess(figureCropProblems({ page, proposed, current: proposed, neighbours: [] }, corrected(40, 40, 900, 900)))).toBe(true)
    const small = box(50, 50, 600, 600)
    expect(problemsOf(figureCropProblems({ page, proposed: small, current: small, neighbours: [] }, corrected(40, 40, 900, 900)))).toEqual([
      "The corrected box covers 81% of the page, but the proposed figure region covers 36%; crop only this figure, never the whole page, its title or neighbouring figures",
    ])
  })

  it("rejects a box that takes in a neighbouring figure even when it covers little of the page", () => {
    const page = pageOf(1000, 1000)
    const proposed = box(100, 100, 100, 100)
    const neighbour = box(250, 100, 100, 100)
    expect(problemsOf(figureCropProblems({ page, proposed, current: proposed, neighbours: [neighbour] }, corrected(100, 100, 260, 100)))).toEqual([
      "The corrected box takes in another figure's region on this page ((250, 100, 100x100)); crop only this figure, without neighbouring figures or steps",
    ])
    expect(Result.isSuccess(figureCropProblems({ page, proposed, current: proposed, neighbours: [neighbour] }, corrected(95, 95, 180, 110)))).toBe(true)
    const overlapping = box(100, 100, 220, 100)
    expect(Result.isSuccess(figureCropProblems({ page, proposed: overlapping, current: overlapping, neighbours: [neighbour] }, corrected(100, 100, 260, 100)))).toBe(true)
  })

  it("lets each round move from the box it was shown, so a pictogram the proposal missed is reached in two rounds", () => {
    // OSHA page 1, run 322b8820: the proposal sat 170 px above the Flammable pictogram (147, 1602, 144x150).
    const page = pageOf(2550, 3300)
    const proposed = box(140, 1430, 150, 150)
    const firstMove = box(145, 1520, 160, 150)
    expect(figureCropProblems({ page, proposed, current: proposed, neighbours: [] }, corrected(145, 1520, 160, 150))).toEqual(Result.succeed({ _tag: "corrected", box: firstMove }))
    expect(figureCropProblems({ page, proposed, current: firstMove, neighbours: [] }, corrected(147, 1602, 144, 150))).toEqual(Result.succeed({ _tag: "corrected", box: box(147, 1602, 144, 150) }))
    expect(problemsOf(figureCropProblems({ page, proposed, current: proposed, neighbours: [] }, corrected(147, 1602, 144, 150)))).toEqual([
      "The corrected box must overlap the given box (140, 1430, 150x150) by at least 25% of the smaller box",
    ])
  })

  it("gives each figure the other proposed regions, so neighbours never depend on which review finishes first", () => {
    const figures = [{ blockIndex: 0, box: { x: 100, y: 100, width: 100, height: 100 } }, { blockIndex: 1, box: null }, { blockIndex: 2, box: { x: 100.4, y: 400, width: 100, height: 100 } }]
    expect(figureNeighbours(figures, 2)).toEqual([box(100, 100, 100, 100)])
    expect(figureNeighbours(figures, 0)).toEqual([box(100, 400, 101, 100)])
    expect(figureNeighbours(figures, 1)).toEqual([box(100, 100, 100, 100), box(100, 400, 101, 100)])
  })
})

describe("unconfirmed figure crops", () => {
  // NASA "3-2-1 Pop!" page 3, run f95005a0: Muse's unconfirmed corrections cut the fins off steps 4 and 5 and the
  // tip off the nose cone, while the proposals held each drawing whole.
  const nasaRerun = [
    { blockIndex: 2, box: { x: 305, y: 600, width: 230, height: 600 } },
    { blockIndex: 4, box: { x: 730, y: 665, width: 360, height: 735 } },
    { blockIndex: 5, box: { x: 950, y: 985, width: 410, height: 785 } },
    { blockIndex: 7, box: { x: 1390, y: 1050, width: 360, height: 1180 } },
    { blockIndex: 8, box: { x: 1700, y: 585, width: 450, height: 1205 } },
    { blockIndex: 10, box: { x: 310, y: 2030, width: 770, height: 860 } },
    { blockIndex: 11, box: { x: 1110, y: 2180, width: 370, height: 560 } },
  ]
  const widenNasa = (blockIndex: number, current: PixelBox) => {
    const { x, y, width, height } = nasaRerun.find((figure) => figure.blockIndex === blockIndex)!.box
    return widenedFigureCrop({ page: nasaPage, proposed: box(x, y, width, height), current, neighbours: figureNeighbours(nasaRerun, blockIndex) })
  }

  it.each([
    ["step 4", 7, box(1385, 1050, 312, 1128), box(1385, 1050, 365, 1180)],
    ["step 5", 8, box(1751, 565, 434, 1245), box(1700, 565, 485, 1245)],
    ["the nose cone", 11, box(1110, 2235, 335, 445), box(1110, 2180, 370, 560)],
  ])("restores the parts of %s that the NASA correction cut off", (_name, blockIndex, current, widened) => {
    expect(widenNasa(blockIndex, current)).toEqual(widened)
  })

  it("restores the top of the toy-brick patent's FIG. 6 that the correction cut off", () => {
    // US 3,005,282 page 1, run cd846c77: the correction moved the top edge down 110 px into the drawing.
    const figures = [
      { blockIndex: 4, box: { x: 390, y: 625, width: 660, height: 530 } },
      { blockIndex: 5, box: { x: 1150, y: 625, width: 730, height: 405 } },
      { blockIndex: 6, box: { x: 1280, y: 1055, width: 590, height: 390 } },
      { blockIndex: 7, box: { x: 315, y: 1175, width: 920, height: 835 } },
      { blockIndex: 8, box: { x: 960, y: 1505, width: 940, height: 560 } },
      { blockIndex: 9, box: { x: 360, y: 1960, width: 1110, height: 745 } },
    ]
    const check = { page: pageOf(2247, 3300), proposed: box(360, 1960, 1110, 745), current: box(335, 2070, 1065, 650), neighbours: figureNeighbours(figures, 9) }
    expect(widenedFigureCrop(check)).toEqual(box(335, 1960, 1135, 760))
  })

  it("keeps the correction when it already holds the proposal or when widening would take in another figure", () => {
    const page = pageOf(1000, 1000)
    expect(widenedFigureCrop({ page, proposed: box(100, 100, 100, 100), current: box(90, 90, 120, 120), neighbours: [] })).toBeNull()
    const proposed = box(100, 100, 100, 100)
    const current = box(150, 150, 100, 100)
    expect(widenedFigureCrop({ page, proposed, current, neighbours: [] })).toEqual(box(100, 100, 150, 150))
    expect(widenedFigureCrop({ page, proposed, current, neighbours: [box(200, 100, 50, 50)] })).toBeNull()
  })
})

describe("figure crop review requests", () => {
  const crop = { bytes: pngBytes, artifact: { path: "images/page-3-figure-3.png", mediaType: "image/png", hash: nasaPage.image.hash, byteCount: pngBytes.byteLength } satisfies ImageArtifact }
  const input = { page: nasaPage, pageImage: pngBytes, crop, box: box(300, 630, 220, 460), neighbours: nasaCheck(2).neighbours, label: "[Figure]", caption: "", round: 1, previous: null }

  it("keeps runs pinned to amuseme-1 byte-identical to the saved NASA request", () => {
    const request = Result.getOrThrow(buildFigureCropRequest({ ...input, promptVersion: "amuseme-1" }, stageLimits))
    expect(request.messages[0].content).toBe(FIGURE_CROP_REVIEW_PROMPT)
    expect(request.messages[1].content[0]).toEqual({ type: "text", text: "{\"figureCropReview\":{\"round\":1,\"maxRounds\":2,\"page\":{\"pageNumber\":3,\"width\":2550,\"height\":3300},\"figure\":{\"label\":\"[Figure]\",\"caption\":\"\"},\"box\":{\"x\":300,\"y\":630,\"width\":220,\"height\":460}}}" })
    expect(publicPrompt("figures-crop-review", "amuseme-1")).toBe(FIGURE_CROP_REVIEW_PROMPT)
  })

  it("tells amuseme-2 reviewers where the page's other figures are and to crop only this one", () => {
    const request = Result.getOrThrow(buildFigureCropRequest({ ...input, promptVersion: "amuseme-2" }, stageLimits))
    expect(request.messages[0].content).toBe(FIGURE_CROP_REVIEW_PROMPT_V2)
    expect(request.messages[0].content).toContain("Never\nreturn the whole page or a box that takes in another figure's region")
    expect(request.messages[0].content).not.toContain("include it\nrather than cut it")
    const sent = JSON.parse(request.messages[1].content[0]?.type === "text" ? request.messages[1].content[0].text : "{}") as { figureCropReview: { otherFigures: ReadonlyArray<unknown> } }
    expect(sent.figureCropReview.otherFigures).toHaveLength(6)
    expect(sent.figureCropReview.otherFigures[0]).toEqual({ x: 750, y: 670, width: 160, height: 570 })
    expect(publicPrompt("figures-crop-review", "amuseme-2")).toBe(FIGURE_CROP_REVIEW_PROMPT_V2)
    expect(publicPrompt("figures-crop-review", "amuseme-3")).toBeNull()
  })
})
