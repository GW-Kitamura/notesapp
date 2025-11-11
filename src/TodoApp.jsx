// TodoApp.jsx（Amplify backend 直結版）
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Authenticator,
  Button,
  Text,
  TextField,
  Heading,
  Flex,
  View,
  Divider,
} from "@aws-amplify/ui-react";
import { Amplify } from "aws-amplify";
import "@aws-amplify/ui-react/styles.css";
import { generateClient } from "aws-amplify/data";
import outputs from "../amplify_outputs.json";

import "./TodoApp.css";

/**
 * Backend 仕様
 * - App.jsx の Note モデルを流用
 *   - name: タスク名
 *   - description: メモ + 末尾にメタ（JSON）を埋め込み
 *     フォーマット: "<メモ本文>\n\n---\nmeta:{\"done\":true|false,\"updatedAt\":number}"
 */

Amplify.configure(outputs);
/** @type {import('aws-amplify/data').Client<any>} */
const client = generateClient({ authMode: "userPool" });

// ---- description に埋め込む簡易メタのシリアライズ/パース ----
const META_PREFIX = "\n\n---\nmeta:";

function packDescription(body, meta) {
  try {
    return `${body || ""}${META_PREFIX}${JSON.stringify(meta || {})}`;
  } catch {
    return `${body || ""}${META_PREFIX}{"done":false}`;
  }
}

function unpackDescription(description) {
  if (!description) return { body: "", meta: { done: false } };
  const idx = description.lastIndexOf(META_PREFIX);
  if (idx === -1) return { body: description, meta: { done: false } };
  const body = description.slice(0, idx);
  const raw = description.slice(idx + META_PREFIX.length);
  try {
    const meta = JSON.parse(raw);
    return { body, meta: { done: !!meta.done, updatedAt: meta.updatedAt ?? null } };
  } catch {
    return { body: description, meta: { done: false } };
  }
}

// ---- Todo 型（UI用）の定義と変換 ----
function noteToTodo(note) {
  const { body, meta } = unpackDescription(note.description);
  return {
    id: note.id,
    title: note.name ?? "",
    memo: body ?? "",
    done: !!meta.done,
    updatedAt: meta.updatedAt ?? null,
    createdAt: note.createdAt ? Date.parse(note.createdAt) : null,
  };
}

function todoToDescription(todo) {
  return packDescription(todo.memo ?? "", {
    done: !!todo.done,
    updatedAt: Date.now(),
  });
}

export default function TodoApp() {
  // --- UI state ---
  const [todos, setTodos] = useState([]);        // backend source of truth
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [memo, setMemo] = useState("");
  const [filter, setFilter] = useState("all");   // all | active | completed
  const [sort, setSort] = useState("created-desc");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [editingMemo, setEditingMemo] = useState("");
  const inputRef = useRef(null);

  // ---- 読み込み＆サブスクライブ（リアルタイム反映） ----
  useEffect(() => {
    let sub;
    (async () => {
      await refresh();
      try {
        // モデル変更のサブスクライブ（利用可の場合）
        sub = client.models.Note.observe().subscribe(() => {
          refresh(); // 変更があれば最新を取得
        });
      } catch {
        // observe が未サポートな場合は無視
      }
    })();
    return () => sub?.unsubscribe?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const { data: items } = await client.models.Note.list();
      const mapped = (items || []).map(noteToTodo);
      setTodos(mapped);
    } finally {
      setLoading(false);
    }
  }

  // ---- CRUD (backend) ----
  async function createFromForm(e) {
    e.preventDefault();
    const t = title.trim();
    const m = memo.trim();
    if (!t) return;

    const description = packDescription(m, { done: false, updatedAt: Date.now() });
    await client.models.Note.create({ name: t, description });
    setTitle("");
    setMemo("");
    inputRef.current?.focus();
    await refresh();
  }

  async function toggleTodo(id, done) {
    const current = todos.find((t) => t.id === id);
    if (!current) return;
    const newDesc = packDescription(current.memo, { done: !done, updatedAt: Date.now() });
    await client.models.Note.update({ id, name: current.title, description: newDesc });
    await refresh();
  }

  async function removeTodo(id) {
    await client.models.Note.delete({ id });
    await refresh();
  }

  function startEdit(todo) {
    setEditingId(todo.id);
    setEditingTitle(todo.title);
    setEditingMemo(todo.memo || "");
  }
  function cancelEdit() {
    setEditingId(null);
    setEditingTitle("");
    setEditingMemo("");
  }
  async function applyEdit() {
    const current = todos.find((t) => t.id === editingId);
    if (!current) return;
    const newTitle = editingTitle.trim();
    const newMemo = editingMemo.trim();
    if (!newTitle) return;

    const newDesc = packDescription(newMemo, {
      done: !!current.done,
      updatedAt: Date.now(),
    });
    await client.models.Note.update({ id: current.id, name: newTitle, description: newDesc });
    cancelEdit();
    await refresh();
  }

  // ---- 表示用フィルタ/ソート/検索 ----
  const filtered = useMemo(() => {
    let list = [...todos];
    if (filter === "active") list = list.filter((t) => !t.done);
    if (filter === "completed") list = list.filter((t) => t.done);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (t) => t.title.toLowerCase().includes(q) || (t.memo || "").toLowerCase().includes(q)
      );
    }
    switch (sort) {
      case "created-asc":
        list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        break;
      case "created-desc":
        list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        break;
      case "alpha-asc":
        list.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "alpha-desc":
        list.sort((a, b) => b.title.localeCompare(a.title));
        break;
      default:
        break;
    }
    return list;
  }, [todos, filter, sort, query]);

  const remaining = useMemo(() => todos.filter((t) => !t.done).length, [todos]);

  // ---- UI ----
  return (
    <Authenticator>
      {({ signOut }) => (
        <div className="app">
          <div className="container">
            {/* Header */}
            <header className="header">
              <div className="header__left">
                <div className="logo" aria-hidden />
                <div className="title">ToDo（Amplify Backend）</div>
                <span className={`badge ${remaining === 0 ? "badge--soft" : "badge--filled"}`}>
                  {remaining} 件残り
                </span>
              </div>
              <div className="header__right">
                <select
                  aria-label="表示フィルター"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="select"
                >
                  <option value="all">すべて</option>
                  <option value="active">未完了</option>
                  <option value="completed">完了済み</option>
                </select>
                <select
                  aria-label="並び順"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  className="select"
                >
                  <option value="created-desc">新しい順</option>
                  <option value="created-asc">古い順</option>
                  <option value="alpha-asc">A → Z</option>
                  <option value="alpha-desc">Z → A</option>
                </select>
                <Button onClick={signOut} className="btn btn--outline-green">
                  Sign Out
                </Button>
              </div>
            </header>

            {/* 追加フォーム（backendに直接追加） */}
            <section className="card">
              <div className="card__title">タスクを追加（バックエンド）</div>
              <div className="card__desc">認証ユーザー単位で Amplify Data に保存します。</div>

              <View as="form" margin="1rem 0 0" onSubmit={createFromForm}>
                <Flex direction="column" gap="0.75rem">
                  <input
                    ref={inputRef}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createFromForm(e)}
                    placeholder="タスク名（必須）"
                    aria-label="タスク名"
                    className="input"
                  />
                  <TextField
                    name="memo"
                    value={memo}
                    onChange={(e) => setMemo(e.target.value)}
                    placeholder="メモ（任意）"
                    label="メモ"
                    labelHidden
                    variation="quiet"
                  />
                  <Button type="submit" variation="primary">
                    追加
                  </Button>
                </Flex>
              </View>

              <div
                style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}
              >
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="検索（タイトル・メモ）"
                  aria-label="検索"
                  className="input"
                  style={{ width: 256, flex: "1 1 auto" }}
                />
              </div>

              <div className="meta">
                <span>
                  合計 {todos.length} 件{loading ? "（更新中…）" : ""} • {new Date().toLocaleString()}
                </span>
                <span>チェックで完了/未完を切替</span>
              </div>
            </section>

            {/* リスト */}
            <section style={{ marginTop: 24 }}>
              <ul className="list">
                {!loading && filtered.length === 0 && (
                  <li>
                    <div className="empty">
                      <div style={{ marginBottom: 4, fontSize: 14 }}>
                        条件に一致するタスクはありません。
                      </div>
                      <div style={{ fontSize: 12 }}>
                        フィルターや検索を解除して新しいタスクを追加してください。
                      </div>
                    </div>
                  </li>
                )}

                {filtered.map((todo) => (
                  <li key={todo.id} className="item">
                    <div className="item__row">
                      <input
                        type="checkbox"
                        className="checkbox"
                        checked={todo.done}
                        onChange={() => toggleTodo(todo.id, todo.done)}
                        aria-label={todo.done ? "未完了に戻す" : "完了にする"}
                      />

                      <div className="item__main">
                        {editingId === todo.id ? (
                          <div
                            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                          >
                            <input
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") applyEdit();
                                if (e.key === "Escape") cancelEdit();
                              }}
                              autoFocus
                              className="input"
                              style={{ flex: "1 1 260px" }}
                            />
                            <TextField
                              value={editingMemo}
                              onChange={(e) => setEditingMemo(e.target.value)}
                              placeholder="メモ（任意）"
                              label="メモ"
                              labelHidden
                              variation="quiet"
                            />
                            <div style={{ display: "flex", gap: 8 }}>
                              <Button className="btn btn--green" onClick={applyEdit}>
                                保存
                              </Button>
                              <Button className="btn" onClick={cancelEdit}>
                                キャンセル
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className={`item__title ${todo.done ? "item__title--done" : ""}`}>
                              {todo.title}
                            </div>
                            <div className="item__sub">
                              {todo.memo || "（メモなし）"}
                            </div>
                            <div className="item__sub" style={{ opacity: 0.8 }}>
                              {todo.done ? "完了更新:" : "作成/更新:"}{" "}
                              {new Date((todo.updatedAt || todo.createdAt || Date.now())).toLocaleString()}
                            </div>
                          </>
                        )}
                      </div>

                      {editingId !== todo.id ? (
                        <div className="item__actions">
                          <Button className="btn btn--outline-green" onClick={() => startEdit(todo)}>
                            編集
                          </Button>
                          <Button className="btn btn--red" onClick={() => removeTodo(todo.id)}>
                            削除
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <Divider style={{ marginTop: 40 }} />
          </div>
        </div>
      )}
    </Authenticator>
  );
}
