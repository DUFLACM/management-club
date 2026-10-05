import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { LoginPage } from '@/pages/LoginPage';
import { AdminLoginPage } from '@/pages/AdminLoginPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { MemberWorkspace } from '@/workspaces/member/MemberWorkspace';
import { AdminWorkspace } from '@/workspaces/admin/AdminWorkspace';

/**
 * 顶层路由。
 * /        → 重定向 /app
 * /app     → 成员工作台（?section= 白名单）
 * /admin   → 管理工作台（?section= 白名单）
 * /admin/login → 独立管理员双阶段登录
 * /login   → CAS 登录辅助页
 * /register→ 邀请注册辅助页
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/app" element={<MemberWorkspace />} />
        <Route path="/admin" element={<AdminWorkspace />} />
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
