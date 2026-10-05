import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { MemberGate, PrincipalGate } from './QueryBoundary';

describe('identity gates', () => {
  it('opens principal-scoped management content for a staff session', () => {
    const renderContent = vi.fn((principalId: string) => (
      <span data-principal={principalId}>管理内容</span>
    ));

    const html = renderToStaticMarkup(
      <PrincipalGate
        principal={{ authenticated: true, principalId: 'principal-staff-1' }}
      >
        {renderContent}
      </PrincipalGate>,
    );

    expect(renderContent).toHaveBeenCalledWith('principal-staff-1');
    expect(html).toContain('管理内容');
    expect(html).not.toContain('请先登录');
  });

  it('does not treat a staff principal as a student member', () => {
    const renderContent = vi.fn((userId: string) => <span>{userId}</span>);

    const html = renderToStaticMarkup(
      <MemberGate
        principal={{
          authenticated: true,
          principalId: 'principal-staff-1',
          userId: null,
        }}
      >
        {renderContent}
      </MemberGate>,
    );

    expect(renderContent).not.toHaveBeenCalled();
    expect(html).toContain('仅协会成员可使用');
    expect(html).toContain('/admin');
  });

  it('passes the student user ID to member-scoped content', () => {
    const renderContent = vi.fn((userId: string) => <span>{userId}</span>);

    const html = renderToStaticMarkup(
      <MemberGate
        principal={{
          authenticated: true,
          principalId: 'principal-student-1',
          userId: 'member-1',
        }}
      >
        {renderContent}
      </MemberGate>,
    );

    expect(renderContent).toHaveBeenCalledWith('member-1');
    expect(html).toContain('member-1');
  });
});
