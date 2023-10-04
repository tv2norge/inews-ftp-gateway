import { literal } from '../helpers'
import { ParsedINewsIntoSegments, SegmentRankings, SegmentRankingsInner } from '../classes/ParsedINewsToSegments'
import { logger } from '../logger'
import { PlaylistChange, PlaylistChangeSegmentMoved, PlaylistChangeType, SegmentChanges } from './DiffPlaylist'
import { RundownId, SegmentId } from './id'
import { ResolvedPlaylistRundown } from './ResolveRundownIntoPlaylist'

const RECALCULATE_RANKS_CHANGE_THRESHOLD = 50
const MAX_TIME_BEFORE_RECALCULATE_RANKS = 60 * 60 * 1000 // One hour
const MINIMUM_ALLOWED_RANK = Math.pow(1 / 2, 30)

export function AssignRanksToSegments(
	rundown: ResolvedPlaylistRundown,
	changes: PlaylistChange[],
	segmentChanges: SegmentChanges,
	previousRanks: SegmentRankings,
	lastRankRecalculation: Map<RundownId, number>
): { assignedRanks: Map<SegmentId, number>; recalculatedAsIntegers: boolean } {
	let assignedRanks: Map<SegmentId, number> = new Map()

	if (segmentChanges.movedSegments.length) {
		logger.debug(`Moved Segments: ${Array.from(segmentChanges.movedSegments.values()).join(',')}`)
	}

	logger.debug(`Getting ranks for ${rundown.rundownId}`)
	let { segmentRanks, recalculatedAsIntegers } = ParsedINewsIntoSegments.GetRanks(
		rundown.rundownId,
		rundown.segments,
		previousRanks,
		segmentChanges,
		logger
	)

	// Check if we should recalculate ranks to integer values from scratch.
	if (!recalculatedAsIntegers && shouldRecalculateRanks(changes, lastRankRecalculation, rundown, segmentRanks)) {
		logger.debug(`Recalculating ranks as integers for ${rundown.rundownId}`)
		segmentRanks = ParsedINewsIntoSegments.RecalculateRanksAsIntegerValues(rundown.segments).segmentRanks

		const rundownPreviousRanks = previousRanks.get(rundown.rundownId)

		if (rundownPreviousRanks) {
			generateMoveChanges(segmentRanks, rundownPreviousRanks, changes, rundown)
		}

		recalculatedAsIntegers = true
	}

	// Store ranks
	for (let [segmentId, rank] of segmentRanks) {
		assignedRanks.set(segmentId, rank)
	}

	return {
		assignedRanks,
		recalculatedAsIntegers,
	}
}

function shouldRecalculateRanks(
	changes: PlaylistChange[],
	lastRankRecalculation: Map<string, number>,
	rundown: ResolvedPlaylistRundown,
	segmentRanks: Map<string, number>
) {
	let prevRank: number | undefined = undefined
	let minRank = Number.POSITIVE_INFINITY
	for (const [_, rank] of segmentRanks) {
		if (prevRank !== undefined) {
			const diffRank = rank - prevRank
			minRank = Math.min(minRank, diffRank)
		}
		prevRank = rank
	}
	return (
		minRank < MINIMUM_ALLOWED_RANK ||
		changes.length >= RECALCULATE_RANKS_CHANGE_THRESHOLD ||
		Date.now() - (lastRankRecalculation.get(rundown.rundownId) ?? 0) >= MAX_TIME_BEFORE_RECALCULATE_RANKS ||
		Array.from(segmentRanks.values()).some((segment) => numberOfDecimals(segment) > 3)
	)
}

function generateMoveChanges(
	segmentRanks: Map<SegmentId, number>,
	rundownPreviousRanks: Map<SegmentId, SegmentRankingsInner>,
	changes: PlaylistChange[],
	rundown: ResolvedPlaylistRundown
) {
	for (let [segmentId, rank] of segmentRanks) {
		const previousRank = rundownPreviousRanks.get(segmentId)

		if (!previousRank) {
			continue
		}

		const alreadyUpdating = changes.some(
			(change) =>
				change.type ===
					(PlaylistChangeType.PlaylistChangeSegmentCreated || PlaylistChangeType.PlaylistChangeSegmentMoved) &&
				change.segmentExternalId === segmentId
		)

		if (!alreadyUpdating && previousRank.rank !== rank) {
			changes.push(
				literal<PlaylistChangeSegmentMoved>({
					type: PlaylistChangeType.PlaylistChangeSegmentMoved,
					rundownExternalId: rundown.rundownId,
					segmentExternalId: segmentId,
				})
			)
		}
	}
}

function numberOfDecimals(val: number) {
	if (Math.floor(val) === val) return 0
	const str = val.toString()
	const pointPosition = str.indexOf('.')
	const ePosition = str.indexOf('e-')
	if (ePosition !== -1) {
		let decimals = Number(str.substring(ePosition + 2))
		if (pointPosition !== -1) {
			decimals += ePosition - pointPosition - 1
		}
		return decimals
	}
	if (str.indexOf('e+') !== -1) return 0
	if (pointPosition !== -1) {
		return str.length - pointPosition - 1
	}
	return 0
}
