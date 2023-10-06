import { INewsClient, INewsFTPStoryOrQueue, INewsStory, INewsFTPStory } from '@tv2media/inews'
import { INewsStoryGW } from './datastructures/Segment'
import { ReducedRundown, ReducedSegment, UnrankedSegment } from './RundownWatcher'
import { literal, parseModifiedDateFromInewsStoryWithFallbackToNow, ReflectPromise } from '../helpers'
import { VERSION } from '../version'
import { SegmentId } from '../helpers/id'
import { ILogger as Logger } from '@tv2media/logger'

function isStory(f: INewsFTPStoryOrQueue): f is INewsFTPStory {
	return f.filetype === 'story'
}

export class RundownManager {
	private _listStories!: (queueName: string) => Promise<Array<INewsFTPStoryOrQueue>>
	private _getStory!: (queueName: string, story: string) => Promise<INewsStory>

	constructor(private _logger?: Logger, private inewsConnection?: INewsClient) {
		if (this.inewsConnection) {
			this._listStories = this.inewsConnection.list.bind(this.inewsConnection)
			this._getStory = this.inewsConnection.story.bind(this.inewsConnection)
		}
	}

	/**
	 * Downloads a rundown by ID.
	 */
	async downloadRundown(rundownId: string): Promise<ReducedRundown> {
		return this.downloadINewsRundown(rundownId)
	}

	/**
	 * Download a rundown from iNews.
	 * @param queueName Name of queue to download.
	 * @param oldRundown Old rundown object.
	 */
	async downloadINewsRundown(queueName: string): Promise<ReducedRundown> {
		const rundown: ReducedRundown = {
			externalId: queueName,
			name: queueName,
			gatewayVersion: VERSION,
			segments: [],
		}
		try {
			let dirList = await this._listStories(queueName)
			dirList.forEach((ftpFileName: INewsFTPStoryOrQueue, index) => {
				if (isStory(ftpFileName)) {
					rundown.segments.push(
						literal<ReducedSegment>({
							externalId: ftpFileName.identifier,
							name: ftpFileName.storyName,
							modified: ftpFileName.modified ?? new Date(0),
							locator: ftpFileName.locator,
							rank: index,
						})
					)
				}
			})
		} catch (error) {
			this._logger?.data(error).error('Error downloading iNews rundown:')
		}
		return rundown
	}

	public async fetchINewsStoriesById(
		queueName: string,
		segmentExternalIds: SegmentId[]
	): Promise<Map<SegmentId, UnrankedSegment>> {
		const stories = new Map<SegmentId, UnrankedSegment>()
		const dirList = await this._listStories(queueName)
		const ps: Array<Promise<INewsStoryGW | undefined>> = []

		for (const storyExternalId of segmentExternalIds) {
			ps.push(this.downloadINewsStoryById(queueName, storyExternalId, dirList))
		}

		const results = await Promise.all(ps.map(ReflectPromise))

		results.forEach((result) => {
			if (result.status === 'fulfilled') {
				const rawSegment = result.value
				if (rawSegment) {
					const segment: UnrankedSegment = {
						externalId: rawSegment.identifier,
						name: rawSegment.fields.title?.value ?? '',
						modified: parseModifiedDateFromInewsStoryWithFallbackToNow(rawSegment),
						locator: rawSegment.locator,
						rundownId: queueName,
						iNewsStory: rawSegment,
					}
					stories.set(rawSegment.identifier, segment)
				}
			}
		})

		return stories
	}

	/*
	 * Download an iNews story.
	 * @param storyFile File to download.
	 * @param oldRundown Old rundown to overwrite.
	 */
	async downloadINewsStory(queueName: string, storyFile: INewsFTPStoryOrQueue): Promise<INewsStoryGW | undefined> {
		let story: INewsStoryGW
		try {
			story = {
				...(await this._getStory(queueName, storyFile.file)),
				identifier: (storyFile as INewsFTPStory).identifier,
				locator: (storyFile as INewsFTPStory).locator,
			}
		} catch (err) {
			this._logger?.error(`Error downloading iNews story: ${err}`)
			return undefined
		}

		this._logger?.debug('Downloaded : ' + queueName + ' : ' + (storyFile as INewsFTPStory).identifier)
		/* Add fileId and update modifyDate to ftp reference in storyFile */
		const newModifyDate = `${storyFile.modified ? storyFile.modified.getTime() / 1000 : 0}`
		if (story.fields.modifyDate) {
			story.fields.modifyDate.value = newModifyDate
		} else {
			story.fields.modifyDate = { value: newModifyDate, attributes: {} }
		}

		this._logger?.debug(`Queue: ${queueName} Story: ${isStory(storyFile) ? storyFile.storyName : storyFile.file}`)

		this.generateCuesFromLayoutField(story)
		return story
	}

	public generateCuesFromLayoutField(story: INewsStory): void {
		if (!story.fields.layout?.value) {
			return
		}
		this.addDesignLayoutCueToStory(story)
		this.addDesignBgCueToStory(story)
	}

	private addDesignLayoutCueToStory(story: INewsStory): void {
		const cueIndex = this.addCueToStory(story, 'DESIGN_LAYOUT')
		this.addLinkToStory(story, cueIndex)
	}

	/**
	 * Adds a new link to the story that references the cue at the 'cueIndex'
	 */
	private addLinkToStory(story: INewsStory, cueIndex: number): void {
		const lines = story.body!.split('<p>')
		const primaryCueIndex = lines.findIndex((line) => !!line.match(/<pi>(.*?)<\/pi>/i))
		story.body =
			primaryCueIndex > 0
				? this.insertLinkAfterFirstPrimaryCue(lines, primaryCueIndex, cueIndex)
				: story.body!.concat(`<p><\a idref="${cueIndex}"></a></p>`)
	}

	private insertLinkAfterFirstPrimaryCue(lines: string[], typeIndex: number, layoutCueIndex: number): string {
		const throughPrimaryCueHalf = lines.slice(0, typeIndex + 1)
		const afterPrimaryCueHalf = lines.slice(typeIndex + 1, lines.length)
		return this.reassembleBody([
			...throughPrimaryCueHalf,
			`<\a idref="${layoutCueIndex}"></a></p>\r\n`,
			...afterPrimaryCueHalf,
		])
	}

	private reassembleBody(lines: string[]): string {
		return lines.reduce((previousValue, currentValue) => {
			return `${previousValue}<p>${currentValue}`
		})
	}

	/**
	 * Adds a cue to the story. Returns the index of the newly added cue.
	 */
	private addCueToStory(story: INewsStory, cueKey: string): number {
		story.cues.push([`${cueKey}=${story.fields.layout!.value!.toUpperCase()}`])
		return story.cues.length - 1
	}

	private addDesignBgCueToStory(story: INewsStory): void {
		const cueIndex = this.addCueToStory(story, 'DESIGN_BG')
		this.addLinkToStory(story, cueIndex)
	}

	/**
	 * Downloads a segment from iNews with a given file name (externalId).
	 * @param queueName Rundown to download from.
	 * @param segmentId Segment to download.
	 */
	async downloadINewsStoryById(
		queueName: string,
		segmentId: string,
		dirList: Array<INewsFTPStoryOrQueue>
	): Promise<INewsStoryGW | undefined> {
		dirList = dirList || (await this._listStories(queueName))
		if (dirList.length > 0) {
			const segment = dirList.find(
				(segment: INewsFTPStoryOrQueue) => (segment as INewsFTPStory).identifier === segmentId
			)

			if (!segment) return Promise.reject(`Cannot find segment with name ${segmentId}`)

			return this.downloadINewsStory(queueName, segment)
		} else {
			return Promise.reject(`Cannot find rundown with Id ${queueName}`)
		}
	}
}
