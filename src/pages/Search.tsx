import { Button, Form, Input, SegmentedControl, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useRef, useState } from "react";
import { api, fmt, isMobile } from "../api";
import type { HotSearchVideo, Post, RankItem, VideoCard } from "../types";
import { useStore } from "../store";
import { MediaCard, Masonry, RankRow } from "../components/cards";
import { Empty, Img } from "../components/ui";
import { IBack, IChevR, IClose, IFireF, IPlayF, IRefresh, ISearch, ITrophy } from "../icons";

const HOT_TAGS = ["都市", "逆袭", "古风", "系统", "后宫", "校园", "仙侠", "职场", "大男主", "御姐", "脑洞", "奇幻"];

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, clearSearchHist, toast } = useStore();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tab, setTab] = useState<"video" | "post">("video");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  /* 请求序号：新关键词或清空时自增，过期请求的结果直接丢弃 */
  const seqRef = useRef(0);
  const [hotVideos, setHotVideos] = useState<HotSearchVideo[]>([]);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotError, setHotError] = useState<string | null>(null);
  const hotBusy = useRef(false);
  const hotLoadedAt = useRef(0);

  /* 移动端进入搜索页不自动聚焦：iOS 会立刻弹键盘遮住内容（#20）。
     桌面端没有软键盘，聚焦便于直接打字。 */
  useEffect(() => {
    if (active && !isMobile) inputRef.current?.focus();
  }, [active]);

  const refreshHot = async () => {
    if (hotBusy.current) return;
    hotBusy.current = true;
    setHotLoading(true);
    setHotError(null);
    try {
      const res = await api.searchHot();
      setHotVideos(res.items);
      hotLoadedAt.current = Date.now();
    } catch (e) {
      setHotError(e instanceof Error ? e.message : "热搜榜加载失败，请重试");
    } finally {
      hotBusy.current = false;
      setHotLoading(false);
    }
  };
  useEffect(() => {
    // 切换主导航时短暂复用榜单；手动刷新始终重新获取官网内容。
    if (active && Date.now() - hotLoadedAt.current > 60_000) void refreshHot();
  }, [active]);

  const run = async (keyword: string, p: number, kind: "video" | "post" = tab) => {
    if (p > 1 && (busy.current || p > pages)) return;
    const seq = p === 1 ? ++seqRef.current : seqRef.current;
    busy.current = true;
    setLoading(true);
    try {
      const res = await api.search(keyword, p, 20, kind);
      if (seq !== seqRef.current) return;
      if (kind === "post") {
        const list = (res?.items || []) as unknown as Post[];
        setPosts((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((x) => x.id));
          return [...base, ...list.filter((x) => !seen.has(x.id))];
        });
      } else {
        const list = (res?.items || []) as unknown as VideoCard[];
        setItems((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((x) => x.id));
          return [...base, ...list.filter((x) => !seen.has(x.id))];
        });
      }
      setPage(p);
      setPages(res?.pagination?.pages || 1);
      setErr(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setErr((e as Error).message || "搜索失败");
    } finally {
      if (seq === seqRef.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  const changeTab = (next: "video" | "post") => {
    if (next === tab) return;
    setTab(next);
    setItems([]);
    setPosts([]);
    setPage(0);
    setPages(1);
    setErr(null);
    if (submitted) void run(submitted, 1, next);
  };

  const submit = (keyword: string) => {
    const k = keyword.trim();
    if (!k) return;
    setSubmitted(k);
    addSearch(k);
    setItems([]);
    setPosts([]);
    setPage(0);
    setPages(1);
    run(k, 1);
  };

  const querying = submitted.length > 0;

  return (
    <div className="ios-page hg-search-view absolute inset-0 bg-bg flex flex-col">
      <header className="hg-search-top shrink-0">
        <div className="hg-search-masthead">
          <span className="hg-search-eyebrow"><span className="hg-live-dot" />HG HUB <i>／</i> DISCOVER</span>
          <Button onClick={() => push({ kind: "ranks" })} aria-label="打开排行榜" className="hg-search-rank-link">
            <ITrophy size={16} /><span>排行榜</span><IChevR size={14} />
          </Button>
        </div>
        <h1 className="hg-search-title">搜一搜，<br /><span>找到下一部上头剧。</span></h1>
        <p className="hg-search-subtitle">短剧、漫剧与新鲜话题，一搜即达</p>
        <Form className="hg-search-form flex items-center"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={19} className="hg-search-input-icon" />
          <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入剧名、题材或关键词"
            className="hg-search-input flex-1 min-w-0" />
          {q && <Button aria-label="清空搜索" type="button" onClick={() => { seqRef.current++; busy.current = false; setLoading(false); setQ(""); setSubmitted(""); setItems([]); setPosts([]); }} className="hg-search-clear"><IClose size={15} /></Button>}
          <Button type="submit" aria-label="开始搜索" className="hg-search-submit"><ISearch size={17} /><span>搜索</span></Button>
        </Form>
      </header>

      <div className="hg-search-content flex-1 scroll-y pb-28">
        {!querying ? (
          <>
            <section className="hg-search-section a-rise" aria-label="热搜榜">
              <div className="hg-section-heading">
                <div><span className="hg-section-kicker">TRENDING NOW</span><h2><IFireF size={17} />正在热搜</h2></div>
                <Button onClick={() => void refreshHot()} disabled={hotLoading} aria-label="刷新热搜榜" className="hg-refresh-link">
                  {hotLoading ? <Loader className="w-3.5 h-3.5" /> : <IRefresh size={14} />}{hotLoading ? "更新中" : "换一换"}
                </Button>
              </div>
              <Surface role="region" aria-label="实时热搜影片" className="hg-hot-board">
                {hotVideos.length > 0 ? (
                  <>
                    <Button aria-label={`播放热搜第一名 ${hotVideos[0].title}`} className="hg-hot-feature"
                      onClick={() => push({ kind: "feed", videoIds: hotVideos.map(item => item.video_id), index: 0, title: "热搜榜" })}>
                      <span className="hg-hot-feature-copy"><span className="hg-hot-feature-label"><IFireF size={13} />今日热度 NO.01</span>
                        <strong>{hotVideos[0].title}</strong><span className="hg-hot-feature-meta">{hotVideos[0].plays || "大家都在看"}</span></span>
                      <span className="hg-hot-play"><IPlayF size={20} /></span>
                    </Button>
                    {hotVideos.length > 1 && <ol className="hg-hot-list" aria-busy={hotLoading}>
                      {hotVideos.slice(1, 7).map((video, index) => (
                        <li key={video.video_id}>
                          <Button aria-label={`播放热搜第 ${index + 2} 名 ${video.title}`} title={video.title} className="hg-hot-row"
                            onClick={() => push({ kind: "feed", videoIds: hotVideos.map(item => item.video_id), index: index + 1, title: "热搜榜" })}>
                            <span className={`hg-hot-rank ${index < 2 ? "is-top" : ""}`}>{String(index + 2).padStart(2, "0")}</span>
                            <span className="hg-hot-row-title">{video.title}</span>
                            <span className="hg-hot-row-plays">{video.plays || "热度上升"}</span><IChevR size={14} />
                          </Button>
                        </li>
                      ))}
                    </ol>}
                  </>
                ) : <div className="hg-hot-empty" role="status">{hotLoading ? "正在获取实时热搜…" : hotError ? "热搜榜暂时不可用，稍后再试试。" : "暂时没有热搜影片"}</div>}
                {hotError && hotVideos.length > 0 && <p role="status" className="hg-hot-note">刷新失败，仍为你保留上次榜单。</p>}
              </Surface>
            </section>

            {searchHist.length > 0 && (
              <section className="hg-search-section hg-history-section a-rise">
                <div className="hg-section-heading compact"><div><span className="hg-section-kicker">PICK UP WHERE YOU LEFT</span><h2>最近搜过</h2></div>
                  <Button onClick={clearSearchHist} className="hg-clear-history">清空</Button></div>
                <div className="hg-search-chips">
                  {searchHist.map((h) => <Button key={h} onClick={() => { setQ(h); submit(h); }} className="hg-search-chip"><ISearch size={13} />{h}</Button>)}
                </div>
              </section>
            )}

            <section className="hg-search-section hg-topics-section a-rise">
              <div className="hg-section-heading compact"><div><span className="hg-section-kicker">PICK A MOOD</span><h2>热门题材</h2></div>
                <Button onClick={() => push({ kind: "ranks" })} className="hg-more-link">看排行榜 <IChevR size={14} /></Button></div>
              <div className="hg-topic-chips">
                {HOT_TAGS.map((t, index) => <Button key={t} onClick={() => { setQ(t); submit(t); }} className={`hg-topic-chip topic-${index % 4}`}>{t}<IChevR size={12} /></Button>)}
              </div>
              <div className="hg-search-prompt"><span className="hg-prompt-mark"><ISearch size={15} /></span><span>还没想好看什么？<strong>点一个题材开始探索</strong></span>
                <Button aria-label="随机推荐题材" onClick={() => submit(HOT_TAGS[Math.floor(Math.random() * HOT_TAGS.length)])}><IRefresh size={15} /></Button></div>
            </section>
          </>
        ) : (
          <section className="hg-search-results">
            <div className="hg-results-topline"><span className="hg-section-kicker">SEARCH RESULTS</span><span>关键词 <strong>“{submitted}”</strong></span></div>
            <SegmentedControl className="hg-results-tabs" aria-label="搜索结果类型" activeIndex={tab === "video" ? 0 : 1}>
              {([["video", "视频"], ["post", "帖子"]] as const).map(([k, label]) => <Button aria-pressed={tab === k} key={k} onClick={() => changeTab(k)}>{label}</Button>)}
            </SegmentedControl>
            <div className="hg-results-count">找到 <strong>{tab === "video" ? items.length : posts.length}</strong> 条内容</div>
            {(tab === "video" ? items.length : posts.length) ? (
              <>
                {tab === "video" ? <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: items.findIndex((x) => x.id === v.id), title: `搜索 · ${submitted}` })} /> : (
                  <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                    {posts.map((post) => <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={`${fmt(post.hot)} 次浏览`} onOpen={() => push({ kind: "post", id: post.id })} />)}
                  </div>
                )}
                <div className="flex justify-center py-5">{loading ? <Loader className="w-6 h-6 spinner" /> : page < pages ? (
                  <Button onClick={() => run(submitted, page + 1)} className="hg-load-more">加载更多</Button>
                ) : <span className="text-[12px] text-dim">— 已经到底啦 —</span>}</div>
              </>
            ) : loading ? <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div> : (
              <Empty icon={<ISearch size={26} />} title={err || "没有找到相关内容"} sub="换个关键词试试，比如「都市」「逆袭」" action="看看热榜" onAction={() => push({ kind: "ranks" })} />
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/* ================= 排行榜 ================= */
const RANK_TABS = [
  { k: "hot", label: "热播榜", desc: "按热力指数排序" },
  { k: "recommend", label: "推荐榜", desc: "按推荐值排序" },
  { k: "potential", label: "潜力榜", desc: "按潜力值排序" },
] as const;

export function RankPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast } = useStore();
  const [tab, setTab] = useState<"hot" | "recommend" | "potential">("hot");
  const [items, setItems] = useState<RankItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.rank(tab)
      .then((res) => { if (alive) setItems(res?.items || []); })
      .catch((e) => { if (alive) { setItems([]); toast((e as Error).message || "榜单加载失败", "info"); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, toast]);

  const max = Math.max(1, ...items.map((x) => x.metric_value || 0));
  const meta = RANK_TABS.find((t) => t.k === tab)!;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 relative overflow-hidden bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
        <div className="relative px-3 pt-2 pb-4">
          <Button aria-label="返回" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <div className="px-2 mt-1 flex items-end justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><ITrophy size={20} /></span>
                <span className="text-[24px] font-bold tracking-wide text-on">HG 热榜</span>
              </div>
              <div className="text-[12px] text-mut mt-1">{meta.desc} · 每 10 分钟更新</div>
            </div>
          </div>
          <SegmentedControl className="mt-3" aria-label="榜单类型" activeIndex={RANK_TABS.findIndex(item => item.k === tab)}>
            {RANK_TABS.map((t) => (
              <Button aria-pressed={tab === t.k} key={t.k} onClick={() => setTab(t.k)}>{t.label}</Button>
            ))}
          </SegmentedControl>
        </div>
      </div>

      <div className="flex-1 scroll-y px-3.5 pt-3 pb-8">
        {loading ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : items.length ? (
          items.map((it) => (
            <RankRow key={`${it.video_id}-${it.rank}`} item={it} metricMax={max}
              onOpen={() => push({ kind: "feed", videoIds: items.map((x) => x.video_id), index: items.findIndex((x) => x.video_id === it.video_id), title: "HG 热榜" })} />
          ))
        ) : (
          <Empty icon={<ITrophy size={26} />} title="榜单暂时为空" sub="稍后再来看看，或者去首页刷刷推荐" />
        )}
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}
