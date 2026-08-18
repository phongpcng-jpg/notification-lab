import { useEffect, useState } from "react";
import { api, type ApiUser, type ApiPost } from "./api.js";

export default function App() {
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [newUserName, setNewUserName] = useState("");
  const [posts, setPosts] = useState<ApiPost[]>([]);
  const [script, setScript] = useState("");
  const [following, setFollowing] = useState<ApiUser[]>([]);
  const [followTargetId, setFollowTargetId] = useState<number | "">("");
  const [status, setStatus] = useState<string>("");

  const refreshUsers = () => api.listUsers().then((r) => setUsers(r.users));
  const refreshPosts = () => api.listPosts().then((r) => setPosts(r.posts));
  const refreshFollowing = (userId: number) =>
    api.listFollowing(userId).then((r) => setFollowing(r.following));

  useEffect(() => {
    refreshUsers();
    refreshPosts();
  }, []);

  useEffect(() => {
    if (currentUserId) refreshFollowing(currentUserId);
  }, [currentUserId]);

  async function handleCreateUser() {
    if (!newUserName.trim()) return;
    const res = await api.createUser(newUserName.trim());
    setNewUserName("");
    await refreshUsers();
    setCurrentUserId(res.id);
  }

  async function handlePost() {
    if (!currentUserId || !script.trim()) return;
    const res = await api.createPost(currentUserId, script.trim());
    setScript("");
    setStatus(
      `Đã đăng. Đã tạo ${res.notificationCount} notification cho follower (chưa đẩy realtime — Phase 2).`
    );
    await refreshPosts();
  }

  async function handleFollow() {
    if (!currentUserId || followTargetId === "") return;
    await api.follow(currentUserId, Number(followTargetId));
    await refreshFollowing(currentUserId);
  }

  async function handleUnfollow(targetId: number) {
    if (!currentUserId) return;
    await api.unfollow(currentUserId, targetId);
    await refreshFollowing(currentUserId);
  }

  const currentUser = users.find((u) => u.id === currentUserId);

  return (
    <div className="app">
      <h1>Notification Realtime Lab</h1>

      <div className="card">
        <h3>1. Chọn vai trò (không cần đăng nhập thật)</h3>
        <select
          value={currentUserId ?? ""}
          onChange={(e) => setCurrentUserId(Number(e.target.value) || null)}
        >
          <option value="">-- chọn user --</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              #{u.id} {u.display_name}
            </option>
          ))}
        </select>
        {" "}
        <input
          placeholder="Tên user mới"
          value={newUserName}
          onChange={(e) => setNewUserName(e.target.value)}
        />
        <button onClick={handleCreateUser}>Tạo user mới</button>
        {currentUser && (
          <p className="muted">Đang đóng vai: #{currentUser.id} {currentUser.display_name}</p>
        )}
      </div>

      {currentUserId && (
        <div className="card">
          <h3>2. Follow (không giới hạn, không tự follow chính mình)</h3>
          <select
            value={followTargetId}
            onChange={(e) => setFollowTargetId(Number(e.target.value) || "")}
          >
            <option value="">-- chọn user để follow --</option>
            {users
              .filter((u) => u.id !== currentUserId)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  #{u.id} {u.display_name}
                </option>
              ))}
          </select>
          <button onClick={handleFollow}>Follow</button>
          <ul>
            {following.map((u) => (
              <li key={u.id}>
                #{u.id} {u.display_name}{" "}
                <button onClick={() => handleUnfollow(u.id)}>Unfollow</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {currentUserId && (
        <div className="card">
          <h3>3. Đăng bài (script + thời gian, không title)</h3>
          <textarea
            rows={3}
            style={{ width: "100%" }}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Nội dung..."
          />
          <br />
          <button onClick={handlePost}>Đăng</button>
          {status && <p className="muted">{status}</p>}
        </div>
      )}

      <div className="card">
        <h3>4. Feed</h3>
        {posts.map((p) => (
          <div key={p.id} className="post-item">
            <strong>{p.author_name ?? `user#${p.author_id}`}</strong>
            <p>{p.script}</p>
            <span className="muted">
              {new Date(p.posted_at * 1000).toLocaleString("vi-VN")}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>5. Notification panel — Phase 2</h3>
        <p className="muted">
          Chọn transport (Short Polling / Long Polling / SSE / WebSocket / Web Push)
          sẽ hiển thị ở đây sau khi implement từng transport endpoint ở backend.
        </p>
      </div>
    </div>
  );
}
