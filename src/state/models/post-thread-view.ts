import {makeAutoObservable, runInAction} from 'mobx'
import {AppBskyFeedGetPostThread as GetPostThread} from '../../third-party/api'
import * as ActorRef from '../../third-party/api/src/client/types/app/bsky/actor/ref'
import {AtUri} from '../../third-party/uri'
import _omit from 'lodash.omit'
import {RootStoreModel} from './root-store'
import * as apilib from '../lib/api'

type MaybePost =
  | GetPostThread.Post
  | GetPostThread.NotFoundPost
  | {
      $type: string
      [k: string]: unknown
    }

function* reactKeyGenerator(): Generator<string> {
  let counter = 0
  while (true) {
    yield `item-${counter++}`
  }
}

interface ReplyingTo {
  author: {
    handle: string
    displayName?: string
    avatar?: string
  }
  text: string
}
interface OriginalRecord {
  text: string
}

export class PostThreadViewPostMyStateModel {
  repost?: string
  upvote?: string
  downvote?: string

  constructor() {
    makeAutoObservable(this)
  }
}

export class PostThreadViewPostModel implements GetPostThread.Post {
  // ui state
  _reactKey: string = ''
  _depth = 0
  _isHighlightedPost = false

  // data
  $type: string = ''
  uri: string = ''
  cid: string = ''
  author: ActorRef.WithInfo = {
    did: '',
    handle: '',
    declaration: {cid: '', actorType: ''},
  }
  record: Record<string, unknown> = {}
  embed?: GetPostThread.Post['embed'] = undefined
  parent?: PostThreadViewPostModel
  replyCount: number = 0
  replies?: PostThreadViewPostModel[]
  repostCount: number = 0
  upvoteCount: number = 0
  downvoteCount: number = 0
  indexedAt: string = ''
  myState = new PostThreadViewPostMyStateModel()

  // added data
  replyingTo?: ReplyingTo

  constructor(
    public rootStore: RootStoreModel,
    reactKey: string,
    v?: GetPostThread.Post,
  ) {
    makeAutoObservable(this, {rootStore: false})
    this._reactKey = reactKey
    if (v) {
      Object.assign(this, _omit(v, 'parent', 'replies', 'myState')) // replies and parent are handled via assignTreeModels
      if (v.myState) {
        Object.assign(this.myState, v.myState)
      }
    }
  }

  assignTreeModels(
    keyGen: Generator<string>,
    v: GetPostThread.Post,
    includeParent = true,
    includeChildren = true,
    isFirstChild = true,
  ) {
    // parents
    if (includeParent && v.parent) {
      // TODO: validate .record
      const parentModel = new PostThreadViewPostModel(
        this.rootStore,
        keyGen.next().value,
        v.parent,
      )
      parentModel._depth = this._depth - 1
      if (v.parent.parent) {
        parentModel.assignTreeModels(keyGen, v.parent, true, false)
      }
      this.parent = parentModel
    }
    if (!includeParent && v.parent?.author.handle && !isFirstChild) {
      this.replyingTo = {
        author: {
          handle: v.parent.author.handle,
          displayName: v.parent.author.displayName,
          avatar: v.parent.author.avatar,
        },
        text: (v.parent.record as OriginalRecord).text,
      }
    }
    // replies
    if (includeChildren && v.replies) {
      const replies = []
      let isChildFirstChild = true
      for (const item of v.replies) {
        // TODO: validate .record
        const itemModel = new PostThreadViewPostModel(
          this.rootStore,
          keyGen.next().value,
          item,
        )
        itemModel._depth = this._depth + 1
        if (item.replies) {
          itemModel.assignTreeModels(
            keyGen,
            item,
            false,
            true,
            isChildFirstChild,
          )
        }
        isChildFirstChild = false
        replies.push(itemModel)
      }
      this.replies = replies
    }
  }

  async toggleUpvote() {
    const wasUpvoted = !!this.myState.upvote
    const wasDownvoted = !!this.myState.downvote
    const res = await this.rootStore.api.app.bsky.feed.setVote({
      subject: {
        uri: this.uri,
        cid: this.cid,
      },
      direction: wasUpvoted ? 'none' : 'up',
    })
    runInAction(() => {
      if (wasDownvoted) {
        this.downvoteCount--
      }
      if (wasUpvoted) {
        this.upvoteCount--
      } else {
        this.upvoteCount++
      }
      this.myState.upvote = res.data.upvote
      this.myState.downvote = res.data.downvote
    })
  }

  async toggleDownvote() {
    const wasUpvoted = !!this.myState.upvote
    const wasDownvoted = !!this.myState.downvote
    const res = await this.rootStore.api.app.bsky.feed.setVote({
      subject: {
        uri: this.uri,
        cid: this.cid,
      },
      direction: wasDownvoted ? 'none' : 'down',
    })
    runInAction(() => {
      if (wasUpvoted) {
        this.upvoteCount--
      }
      if (wasDownvoted) {
        this.downvoteCount--
      } else {
        this.downvoteCount++
      }
      this.myState.upvote = res.data.upvote
      this.myState.downvote = res.data.downvote
    })
  }

  async toggleRepost() {
    if (this.myState.repost) {
      await apilib.unrepost(this.rootStore, this.myState.repost)
      runInAction(() => {
        this.repostCount--
        this.myState.repost = undefined
      })
    } else {
      const res = await apilib.repost(this.rootStore, this.uri, this.cid)
      runInAction(() => {
        this.repostCount++
        this.myState.repost = res.uri
      })
    }
  }

  async delete() {
    await this.rootStore.api.app.bsky.feed.post.delete({
      did: this.author.did,
      rkey: new AtUri(this.uri).rkey,
    })
  }
}

export class PostThreadViewModel {
  // state
  isLoading = false
  isRefreshing = false
  hasLoaded = false
  error = ''
  notFound = false
  resolvedUri = ''
  params: GetPostThread.QueryParams

  // data
  thread?: PostThreadViewPostModel

  constructor(
    public rootStore: RootStoreModel,
    params: GetPostThread.QueryParams,
  ) {
    makeAutoObservable(
      this,
      {
        rootStore: false,
        params: false,
      },
      {autoBind: true},
    )
    this.params = params
  }

  get hasContent() {
    return typeof this.thread !== 'undefined'
  }

  get hasError() {
    return this.error !== ''
  }

  // public api
  // =

  /**
   * Load for first render
   */
  async setup() {
    if (!this.resolvedUri) {
      await this._resolveUri()
    }
    if (this.hasContent) {
      await this.update()
    } else {
      await this._load()
    }
  }

  /**
   * Reset and load
   */
  async refresh() {
    await this._load(true)
  }

  /**
   * Update content in-place
   */
  async update() {
    // NOTE: it currently seems that a full load-and-replace works fine for this
    //       if the UI loses its place or has jarring re-arrangements, replace this
    //       with a more in-place update
    this._load()
  }

  // state transitions
  // =

  private _xLoading(isRefreshing = false) {
    this.isLoading = true
    this.isRefreshing = isRefreshing
    this.error = ''
    this.notFound = false
  }

  private _xIdle(err: any = undefined) {
    this.isLoading = false
    this.isRefreshing = false
    this.hasLoaded = true
    this.error = err ? err.toString() : ''
    this.notFound = err instanceof GetPostThread.NotFoundError
  }

  // loader functions
  // =

  private async _resolveUri() {
    const urip = new AtUri(this.params.uri)
    if (!urip.host.startsWith('did:')) {
      try {
        urip.host = await this.rootStore.resolveName(urip.host)
      } catch (e: any) {
        this.error = e.toString()
      }
    }
    runInAction(() => {
      this.resolvedUri = urip.toString()
    })
  }

  private async _load(isRefreshing = false) {
    this._xLoading(isRefreshing)
    try {
      const res = await this.rootStore.api.app.bsky.feed.getPostThread(
        Object.assign({}, this.params, {uri: this.resolvedUri}),
      )
      this._replaceAll(res)
      this._xIdle()
    } catch (e: any) {
      this._xIdle(e)
    }
  }

  private _replaceAll(res: GetPostThread.Response) {
    // TODO: validate .record
    sortThread(res.data.thread)
    const keyGen = reactKeyGenerator()
    const thread = new PostThreadViewPostModel(
      this.rootStore,
      keyGen.next().value,
      res.data.thread as GetPostThread.Post,
    )
    thread._isHighlightedPost = true
    thread.assignTreeModels(keyGen, res.data.thread as GetPostThread.Post)
    this.thread = thread
  }
}

function sortThread(post: MaybePost) {
  if (post.notFound) {
    return
  }
  post = post as GetPostThread.Post
  if (post.replies) {
    post.replies.sort((a: MaybePost, b: MaybePost) => {
      post = post as GetPostThread.Post
      if (a.notFound) {
        return 1
      }
      if (b.notFound) {
        return -1
      }
      a = a as GetPostThread.Post
      b = b as GetPostThread.Post
      const aIsByOp = a.author.did === post.author.did
      const bIsByOp = b.author.did === post.author.did
      if (aIsByOp && bIsByOp) {
        return a.indexedAt.localeCompare(b.indexedAt) // oldest
      } else if (aIsByOp) {
        return -1 // op's own reply
      } else if (bIsByOp) {
        return 1 // op's own reply
      }
      return b.indexedAt.localeCompare(a.indexedAt) // newest
    })
    post.replies.forEach(reply => sortThread(reply))
  }
}
