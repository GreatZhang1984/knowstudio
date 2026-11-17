import { Alert, Tag } from 'antd';
import type { ReactNode } from 'react';

export interface PageStubProps {
  pageId: string;
  title: string;
  /** 该页的业务实现由哪个任务交付，避免占位页被误当成功能缺失。 */
  note: string;
  children?: ReactNode;
}

export function PageStub({ pageId, title, note, children }: PageStubProps) {
  return (
    <section className="page-stub">
      <div className="page-stub__head">
        <h1>{title}</h1>
        <Tag>{pageId}</Tag>
      </div>
      <p className="page-stub__note">{note}</p>
      {children}
      <Alert
        type="info"
        showIcon
        message="T-07 占位页"
        description="路由、布局与主题已就绪，页面业务实现由后续任务交付。"
      />
    </section>
  );
}