export interface HistoryPoint {
	id: string
	recordedAt: string
	price: number | null
	currency: string | null
	displayPrice: number | null
	displayCurrency: string | null
}

interface GraphPoint {
	time: number
	price: number
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const GRAPH_WIDTH = 600
const GRAPH_HEIGHT = 300
const LEFT = 100
const RIGHT = GRAPH_WIDTH - 20
const TOP = 20
const BOTTOM = GRAPH_HEIGHT - 40

function readGraphPoints(points: HistoryPoint[]): GraphPoint[] {
	const graphPoints: GraphPoint[] = []
	for (const point of points) {
		const time = Date.parse(point.recordedAt)
		if (point.displayPrice === null || Number.isNaN(time)) {
			continue
		}
		graphPoints.push({ time, price: point.displayPrice })
	}
	return graphPoints
}

function findRange(values: number[]) {
	let low = values[0]
	let high = values[0]
	for (const value of values) {
		if (value < low) {
			low = value
		}
		if (value > high) {
			high = value
		}
	}
	return { low, high }
}

function scale(value: number, low: number, high: number, start: number, end: number): number {
	if (high === low) {
		return (start + end) / 2
	}
	const fraction = (value - low) / (high - low)
	return start + fraction * (end - start)
}

function isPriceChange(graphPoints: GraphPoint[], index: number): boolean {
	if (index === 0) {
		return true
	}
	return graphPoints[index].price !== graphPoints[index - 1].price
}

function addSvgElement(svg: SVGSVGElement, name: string, attributes: Record<string, string>): SVGElement {
	const element = document.createElementNS(SVG_NAMESPACE, name)
	for (const key in attributes) {
		element.setAttribute(key, attributes[key])
	}
	svg.append(element)
	return element
}

function addLine(svg: SVGSVGElement, x1: number, y1: number, x2: number, y2: number) {
	addSvgElement(svg, 'line', {
		x1: String(x1),
		y1: String(y1),
		x2: String(x2),
		y2: String(y2),
		stroke: 'black',
	})
}

function addText(svg: SVGSVGElement, text: string, x: number, y: number, anchor: string) {
	const element = addSvgElement(svg, 'text', {
		x: String(x),
		y: String(y),
		'text-anchor': anchor,
		'font-size': '12',
	})
	element.textContent = text
}

function formatGraphPrice(price: number, currency: string): string {
	return `${price.toFixed(2)} ${currency}`
}

function formatGraphTime(time: number): string {
	return new Date(time).toLocaleString()
}

export function drawPriceGraph(svg: SVGSVGElement, points: HistoryPoint[], currency: string) {
	svg.replaceChildren()
	svg.setAttribute('width', String(GRAPH_WIDTH))
	svg.setAttribute('height', String(GRAPH_HEIGHT))

	const graphPoints = readGraphPoints(points)
	if (graphPoints.length === 0) {
		addText(svg, 'No price history yet.', GRAPH_WIDTH / 2, GRAPH_HEIGHT / 2, 'middle')
		return
	}

	const times: number[] = []
	const prices: number[] = []
	for (const point of graphPoints) {
		times.push(point.time)
		prices.push(point.price)
	}
	const timeRange = findRange(times)
	const priceRange = findRange(prices)

	addLine(svg, LEFT, TOP, LEFT, BOTTOM)
	addLine(svg, LEFT, BOTTOM, RIGHT, BOTTOM)

	const coordinates: string[] = []
	for (let index = 0; index < graphPoints.length; index++) {
		const point = graphPoints[index]
		const x = scale(point.time, timeRange.low, timeRange.high, LEFT, RIGHT)
		const y = scale(point.price, priceRange.low, priceRange.high, BOTTOM, TOP)
		coordinates.push(`${x},${y}`)
		if (isPriceChange(graphPoints, index)) {
			addSvgElement(svg, 'circle', { cx: String(x), cy: String(y), r: '3', fill: 'black' })
		}
	}
	addSvgElement(svg, 'polyline', {
		points: coordinates.join(' '),
		fill: 'none',
		stroke: 'black',
	})

	const highY = scale(priceRange.high, priceRange.low, priceRange.high, BOTTOM, TOP)
	addText(svg, formatGraphPrice(priceRange.high, currency), LEFT - 6, highY + 4, 'end')
	if (priceRange.low !== priceRange.high) {
		addText(svg, formatGraphPrice(priceRange.low, currency), LEFT - 6, BOTTOM + 4, 'end')
	}

	if (timeRange.low === timeRange.high) {
		addText(svg, formatGraphTime(timeRange.low), (LEFT + RIGHT) / 2, BOTTOM + 20, 'middle')
	} else {
		addText(svg, formatGraphTime(timeRange.low), LEFT, BOTTOM + 20, 'start')
		addText(svg, formatGraphTime(timeRange.high), RIGHT, BOTTOM + 20, 'end')
	}
}
